import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { syncEmployeesFromDauoffice } from './sync-employees';
import { probeAttendanceCodes } from './probe-attendance-codes';

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

const probeSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * 2026-09-04: "다우오피스 전사휴가현황을 상황판에 연동해달라"는 요청 때문에 만든 1회성 진단
 * 엔드포인트 — DB에는 아무것도 쓰지 않고, attnd-v2/attnd 응답의 코드값 조합만 모아서 그대로
 * 보여준다. 휴가로 보이는 날짜(예: 다우오피스 전사휴가현황에서 확인한 실제 휴가자·날짜)와
 * 여기 결과를 대조해서 어떤 dayWorkStatusCode가 휴가를 의미하는지 확인한 뒤, 확인되면
 * 정식 연동 기능으로 옮긴다.
 */
dauofficeRouter.get('/probe/attendance-codes', async (req, res) => {
  const parsed = probeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'startDate, endDate(YYYY-MM-DD)가 필요합니다.' } });
  }
  try {
    const result = await probeAttendanceCodes(parsed.data.startDate, parsed.data.endDate);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, error: { code: 'DAUOFFICE_ERROR', message: (err as Error).message } });
  }
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
