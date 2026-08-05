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

const updateSchema = z.object({
  key: z.string(),
  value: z.string(),
  valueType: z.enum(['BOOLEAN', 'NUMBER', 'STRING', 'JSON']),
  scopeDepartmentId: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
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
