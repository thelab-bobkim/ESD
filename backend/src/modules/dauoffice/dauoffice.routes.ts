import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { syncEmployeesFromDauoffice } from './sync-employees';

export const dauofficeRouter = Router();
dauofficeRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

/** 직원(조직도) 수동 동기화 트리거 */
dauofficeRouter.post('/sync/employees', async (req, res) => {
  const result = await syncEmployeesFromDauoffice(req.authUser!.userId);
  return res.json({ success: true, data: result });
});

// 2026-09-01: "근태(출퇴근) 동기화"는 제거했다 — 다우오피스가 퇴근시각을 제공하지 않아 매달
// clockInAt만 채운 미해결(퇴근 없음) 기록이 계속 쌓이는 원인이었다(정정 신청 목록이 끝없이
// 쌓이던 문제). 사용자 요청으로 이 버튼/엔드포인트를 없앴다 — 출퇴근은 이제 앱 안에서 직원이
// 직접 누른 것만 기록으로 인정한다. 조직도(직원) 동기화는 부서 변경 등을 반영해야 하므로 유지.
// (구현은 sync-attendance.ts에 남아있지만 더 이상 라우트에 연결하지 않는다.)

/** 부서명 수동 보정값 목록 조회 (AMS의 하드코딩 DEPT_MAP을 대체하는 테이블) */
dauofficeRouter.get('/department-overrides', async (_req, res) => {
  const overrides = await prisma.dauofficeDepartmentOverride.findMany({ orderBy: { dauofficeLoginId: 'asc' } });
  return res.json({ success: true, data: overrides });
});

const upsertOverrideSchema = z.object({
  dauofficeLoginId: z.string().min(1),
  departmentName: z.string().min(1),
});

/** 부서명 수동 보정값 추가/수정 */
dauofficeRouter.put('/department-overrides', async (req, res) => {
  const parsed = upsertOverrideSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const { dauofficeLoginId, departmentName } = parsed.data;
  const updated = await prisma.dauofficeDepartmentOverride.upsert({
    where: { dauofficeLoginId },
    update: { departmentName },
    create: { dauofficeLoginId, departmentName },
  });
  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'POLICY_CHANGE',
    targetType: 'dauoffice_department_override',
    targetId: updated.id,
    afterValue: updated,
  });
  return res.json({ success: true, data: updated });
});

/** 부서명 수동 보정값 삭제 */
dauofficeRouter.delete('/department-overrides/:loginId', async (req, res) => {
  const existing = await prisma.dauofficeDepartmentOverride.findUnique({
    where: { dauofficeLoginId: req.params.loginId },
  });
  if (!existing) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '보정값을 찾을 수 없습니다.' } });
  }
  await prisma.dauofficeDepartmentOverride.delete({ where: { id: existing.id } });
  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'POLICY_CHANGE',
    targetType: 'dauoffice_department_override',
    targetId: existing.id,
    beforeValue: existing,
  });
  return res.json({ success: true, data: { deleted: true } });
});
