import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { syncEmployeesFromDauoffice } from './sync-employees';
import { syncAttendanceFromDauoffice } from './sync-attendance';

export const dauofficeRouter = Router();
dauofficeRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

/** 직원(조직도) 수동 동기화 트리거 */
dauofficeRouter.post('/sync/employees', async (req, res) => {
  const result = await syncEmployeesFromDauoffice(req.authUser!.userId);
  return res.json({ success: true, data: result });
});

const syncAttendanceSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

/** 근태(출근) 수동 동기화 트리거 — 월 단위 */
dauofficeRouter.post('/sync/attendance', async (req, res) => {
  const parsed = syncAttendanceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'year, month가 필요합니다.' } });
  }
  const result = await syncAttendanceFromDauoffice(parsed.data.year, parsed.data.month, req.authUser!.userId);
  return res.json({ success: true, data: result });
});

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
