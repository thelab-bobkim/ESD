import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { invalidatePolicyCache } from '../../common/policy-engine/policy-engine';

// 주의(MVP 한계): scopeDepartmentId가 NULL인 "전사 기본값" 행은 PostgreSQL의 NULL 유일성 특성상
// upsert 경합 시 중복 생성될 수 있다. 전사 확산 단계에서는 scopeDepartmentId를
// NOT NULL + 'GLOBAL' sentinel 값으로 마이그레이션하는 것을 권장한다.
export const policyRouter = Router();
policyRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

policyRouter.get('/settings', async (_req, res) => {
  const settings = await prisma.policySetting.findMany({ orderBy: { key: 'asc' } });
  return res.json({ success: true, data: settings });
});

// 2026-09-30 수정: value를 valueType과 대조 없이 그냥 문자열로만 받아 저장했었다 — policy-engine.ts의
// getPolicyNumber/getPolicyJSON은 저장된 값이 실제로 그 타입으로 파싱이 안 되면(예: NUMBER인데
// "18:00"처럼 숫자가 아닌 문자열) 에러를 내지 않고 그냥 조용히 호출부의 기본값(fallback)으로
// 되돌아간다. 그러면 관리자는 "저장 성공"만 보고 정책이 바뀌었다고 믿는데, 실제로는 이후 모든
// REGULAR_WORK_END_HOUR 등 임계값 조회가 계속 원래 하드코딩된 기본값을 쓰게 되어 정책 변경이
// 조용히 무시된다. 저장 시점에 미리 막는다.
const updateSchema = z
  .object({
    key: z.string(),
    value: z.string(),
    valueType: z.enum(['BOOLEAN', 'NUMBER', 'STRING', 'JSON']),
    scopeDepartmentId: z.string().uuid().nullable().optional(),
    description: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.valueType === 'NUMBER' && (data.value.trim() === '' || !Number.isFinite(Number(data.value)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'NUMBER 타입은 숫자여야 합니다.' });
    }
    if (data.valueType === 'BOOLEAN' && data.value !== 'true' && data.value !== 'false') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: "BOOLEAN 타입은 'true' 또는 'false'여야 합니다." });
    }
    if (data.valueType === 'JSON') {
      try {
        JSON.parse(data.value);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'JSON 타입은 올바른 JSON 문자열이어야 합니다.' });
      }
    }
  });

policyRouter.put('/settings', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const actorUserId = req.authUser!.userId;
  const { key, value, valueType, scopeDepartmentId, description } = parsed.data;
  const scopeId = scopeDepartmentId ?? null;

  // 참고: Prisma는 복합 유니크 키(key+scopeDepartmentId)에 null을 타입상 허용하지 않으므로
  // upsert 대신 findFirst + create/update로 처리한다(기능적으로 동일).
  const before = await prisma.policySetting.findFirst({ where: { key, scopeDepartmentId: scopeId } });

  const updated = before
    ? await prisma.policySetting.update({
        where: { id: before.id },
        data: { value, valueType, description, updatedBy: actorUserId },
      })
    : await prisma.policySetting.create({
        data: { key, value, valueType, description, scopeDepartmentId: scopeId, updatedBy: actorUserId },
      });

  invalidatePolicyCache();

  await recordAuditLog({
    actorUserId,
    actionType: 'POLICY_CHANGE',
    targetType: 'policy_setting',
    targetId: updated.id,
    beforeValue: before,
    afterValue: updated,
  });

  return res.json({ success: true, data: updated });
});
