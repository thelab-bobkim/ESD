import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly, realDayWindow, applyAttendanceCorrection, checkMinWorkedMinutes, combineDateTime } from '../../common/attendance-helpers';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

export const attendanceCorrectionRouter = Router();
attendanceCorrectionRouter.use(requireAuth);

/**
 * 퇴근을 못 누르고 날짜가 넘어가버린 근태(=오늘이 아닌 과거 workDate인데 clockInAt은 있고
 * clockOutAt이 없는 기록)를 본인 확인용으로 조회한다. 프론트는 이 목록이 비어있지 않으면
 * 다른 상태변경을 막고 "지난 근무일 퇴근 정정 신청"을 먼저 하도록 유도한다(강제 자동퇴근 금지 원칙 —
 * core_principles 참고 — 이므로 시스템이 임의로 시각을 채우지 않고 반드시 본인이 입력/신청해야 함).
 */
attendanceCorrectionRouter.get('/pending', async (req, res) => {
  const userId = req.authUser!.userId;
  const today = todayDateOnly();

  const unresolved = await prisma.attendanceRecord.findMany({
    where: { userId, workDate: { lt: today }, clockInAt: { not: null }, clockOutAt: null },
    orderBy: { workDate: 'desc' },
    include: {
      correctionRequests: { orderBy: { createdAt: 'desc' }, take: 1, include: { approvalRequest: true } },
    },
  });

  const rows = unresolved.map((r) => ({
    attendanceRecordId: r.id,
    workDate: r.workDate,
    clockInAt: r.clockInAt,
    latestRequest: r.correctionRequests[0]
      ? {
          id: r.correctionRequests[0].id,
          status: r.correctionRequests[0].status,
          proposedClockOutAt: r.correctionRequests[0].proposedClockOutAt,
          reason: r.correctionRequests[0].reason,
        }
      : null,
  }));

  return res.json({ success: true, data: rows });
});

const requestSchema = z.object({
  attendanceRecordId: z.string().uuid(),
  proposedClockOutAt: z.string().min(1), // ISO datetime-local 문자열
  // 육하원칙 반영 원칙과 동일하게, 최소 10자 이상의 구체적인 사유를 요구한다.
  reason: z.string().trim().min(10, '사유를 10자 이상 구체적으로 입력해주세요.'),
});

/**
 * 지난 근무일 퇴근 정정을 신청한다. 이 신청만으로는 근태 기록이 바뀌지 않고, 팀장/HR/시스템관리자가
 * 승인해야 실제 clock_out_at/total_worked_minutes에 반영된다(approval.routes.ts 참고) — 법적으로
 * 민감한 근로시간 기록을 시스템이나 관리자가 일방적으로 확정하지 않기 위함.
 */
attendanceCorrectionRouter.post('/requests', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const userId = req.authUser!.userId;
  const { attendanceRecordId, reason } = parsed.data;

  const record = await prisma.attendanceRecord.findUnique({ where: { id: attendanceRecordId } });
  if (!record || record.userId !== userId) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '근태 기록을 찾을 수 없습니다.' } });
  }
  if (!record.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CLOCKED_IN', message: '출근 기록이 없는 날은 정정 신청할 수 없습니다.' } });
  }
  if (record.clockOutAt) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_CLOCKED_OUT', message: '이미 퇴근 처리된 기록입니다.' } });
  }
  const today = todayDateOnly();
  if (record.workDate >= today) {
    return res.status(400).json({
      success: false,
      error: { code: 'USE_NORMAL_CLOCKOUT', message: '오늘 근무는 퇴근 버튼으로 처리해주세요. 정정 신청은 지난 근무일에만 가능합니다.' },
    });
  }

  const existingPending = await prisma.attendanceCorrectionRequest.findFirst({
    where: { attendanceRecordId, status: 'PENDING' },
  });
  if (existingPending) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_PENDING', message: '이미 승인 대기중인 정정 신청이 있습니다.' } });
  }

  const proposedClockOutAt = new Date(parsed.data.proposedClockOutAt);
  if (Number.isNaN(proposedClockOutAt.getTime())) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '퇴근 시각 형식이 올바르지 않습니다.' } });
  }
  // 2026-09-14: 안중석 피드백 — 주말작업처럼 새벽 3시를 넘겨서까지 실제로 근무한 경우, 상한을
  // "그 workDate의 새벽 3시"로 고정해두면 실제 퇴근시각이 그보다 늦다는 이유만으로 정정 신청
  // 자체를 낼 수 없었다(토요일 19:51 출근 → 일요일 08시경 퇴근인데도 거절됨). 이 신청이 막히면
  // PastDayCorrectionCard 규칙상 다음 근무일 상태 등록까지 연쇄로 막혀버린다. 상한을 "지금(미래
  // 금지)"으로 완화해서, 실제로 얼마나 늦게까지 일했든 신청은 가능하게 하고, 그 시각이 적절한지는
  // 기존처럼 팀장/HR 승인 단계(approval.routes.ts)에서 사람이 확인하게 한다.
  const { start: dayStart } = realDayWindow(record.workDate);
  const now = new Date();
  if (proposedClockOutAt <= record.clockInAt || proposedClockOutAt < dayStart || proposedClockOutAt > now) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'OUT_OF_RANGE',
        message: '퇴근 시각은 그날 출근 이후, 현재 시각 이전이어야 합니다.',
      },
    });
  }

  const correction = await prisma.attendanceCorrectionRequest.create({
    data: { userId, attendanceRecordId, type: 'MISSING_CLOCK_OUT', proposedClockOutAt, reason },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      type: 'ATTENDANCE_CORRECTION',
      referenceId: correction.id,
      requesterId: userId,
      attendanceCorrectionRequestId: correction.id,
    },
  });

  await recordAuditLog({
    actorUserId: userId,
    actionType: 'STATUS_CHANGE',
    targetType: 'attendance_correction_request',
    targetId: correction.id,
    afterValue: { correction, approval },
  });

  // TSB-Ver3.1: 저위험 정정요청 자동승인 — 2026-09-11 개선 제안서 Quick win 반영.
  // 제안 퇴근시각이 정규 근무종료 시각(정책값 REGULAR_WORK_END_HOUR) 근처(±30분)이고, 그렇게
  // 확정해도 최소근무시간(정책값, 기본 8시간)을 채우는 경우에만 자동승인한다. 최소근무시간을
  // 못 채우는 애매한 건은 기존 사고 방지 규칙(EARLY_LEAVE_REASON_REQUIRED)과 동일하게 반드시
  // 사람이 확인하도록 그대로 승인대기 상태로 남긴다.
  let autoApproved = false;
  const AUTO_APPROVE_WINDOW_MINUTES = 30;
  const regularWorkEndHour = await getPolicyNumber('REGULAR_WORK_END_HOUR', 18);
  const regularCutoff = combineDateTime(record.workDate, `${String(regularWorkEndHour).padStart(2, '0')}:00`);
  const diffFromCutoffMinutes = Math.abs((proposedClockOutAt.getTime() - regularCutoff.getTime()) / 60000);

  if (diffFromCutoffMinutes <= AUTO_APPROVE_WINDOW_MINUTES) {
    const { ok } = await checkMinWorkedMinutes(record.clockInAt, proposedClockOutAt);
    if (ok) {
      await prisma.approvalRequest.update({
        where: { id: approval.id },
        data: {
          status: 'APPROVED',
          decidedAt: new Date(),
          comment: `자동승인: 정규 근무종료(${String(regularWorkEndHour).padStart(2, '0')}:00) 시각 인근의 단순 퇴근 누락으로 자동 확정됨`,
        },
      });
      const applied = await applyAttendanceCorrection(correction.id);
      if (applied) {
        autoApproved = true;
        await recordAuditLog({
          actorUserId: userId,
          actionType: 'CORRECT',
          targetType: 'attendance_record',
          targetId: applied.updatedRecord.id,
          afterValue: {
            clockOutAt: applied.updatedRecord.clockOutAt,
            totalWorkedMinutes: applied.totalWorkedMinutes,
            correctionReason: applied.correction.reason,
            autoApproved: true,
          },
        });
      }
    }
  }

  return res.json({ success: true, data: { request: correction, approval, autoApproved } });
});

attendanceCorrectionRouter.get('/requests/me', async (req, res) => {
  const userId = req.authUser!.userId;
  const requests = await prisma.attendanceCorrectionRequest.findMany({
    where: { userId },
    include: { approvalRequest: true, attendanceRecord: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ success: true, data: requests });
});

/**
 * 2026-09-16: "오늘 퇴근을 잘못 눌렀는데 되돌릴 방법이 없다"(채수권·윤유상 피드백) 반영.
 * 상태 아이콘 오클릭엔 10분 내 되돌리기가 있지만 퇴근 버튼엔 없었고, 위의 정정 신청은
 * "지난 근무일 퇴근 누락"만 다뤄서 오늘 날짜는 애초에 신청 대상이 아니었다(USE_NORMAL_CLOCKOUT로
 * 거절됨). 오늘 퇴근을 취소해 다시 근무중 상태로 되돌리는 별도 신청 — 근태 기록을 되돌리는
 * 것이므로 지난 근무일 정정과 동일하게 팀장/HR 승인을 거쳐야 실제 반영된다(applyAttendanceCorrection
 * 참고). 자동승인은 두지 않는다 — 하루 전체를 다시 여는 조치라 사람이 확인하는 게 안전하다.
 */
const cancelClockOutSchema = z.object({
  reason: z.string().trim().min(10, '사유를 10자 이상 구체적으로 입력해주세요.'),
});

attendanceCorrectionRouter.post('/cancel-clock-out', async (req, res) => {
  const parsed = cancelClockOutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const userId = req.authUser!.userId;
  const today = todayDateOnly();

  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate: today } } });
  if (!record || !record.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CLOCKED_IN', message: '오늘 출근 기록이 없습니다.' } });
  }
  if (!record.clockOutAt) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CLOCKED_OUT', message: '아직 퇴근 처리되지 않았습니다.' } });
  }

  const existingPending = await prisma.attendanceCorrectionRequest.findFirst({
    where: { attendanceRecordId: record.id, status: 'PENDING' },
  });
  if (existingPending) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_PENDING', message: '이미 승인 대기중인 정정 신청이 있습니다.' } });
  }

  const correction = await prisma.attendanceCorrectionRequest.create({
    data: { userId, attendanceRecordId: record.id, type: 'CANCEL_CLOCK_OUT', reason: parsed.data.reason },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      type: 'ATTENDANCE_CORRECTION',
      referenceId: correction.id,
      requesterId: userId,
      attendanceCorrectionRequestId: correction.id,
    },
  });

  await recordAuditLog({
    actorUserId: userId,
    actionType: 'STATUS_CHANGE',
    targetType: 'attendance_correction_request',
    targetId: correction.id,
    afterValue: { correction, approval },
  });

  return res.json({ success: true, data: { request: correction, approval } });
});

/** 오늘자 "퇴근 취소" 신청의 최신 상태 — 프론트가 대기중/반려 배지를 보여주는 용도. */
attendanceCorrectionRouter.get('/cancel-clock-out/today', async (req, res) => {
  const userId = req.authUser!.userId;
  const today = todayDateOnly();

  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate: today } } });
  if (!record) return res.json({ success: true, data: null });

  const latest = await prisma.attendanceCorrectionRequest.findFirst({
    where: { attendanceRecordId: record.id, type: 'CANCEL_CLOCK_OUT' },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return res.json({ success: true, data: null });

  return res.json({ success: true, data: { status: latest.status, reason: latest.reason, createdAt: latest.createdAt } });
});
