import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole, type AuthUser } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { applyAttendanceCorrection, checkMinWorkedMinutes } from '../../common/attendance-helpers';

export const approvalRouter = Router();
approvalRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'));

/**
 * 2026-08-30 보안점검: 예전엔 TEAM_LEAD 역할만 있으면 부서 상관없이 아무 요청이나 조회/승인/반려할
 * 수 있었다(UserRole.scopeDepartmentId가 스키마에 있는데도 실제로는 어디서도 쓰이지 않았음).
 * HR_ADMIN/SYSTEM_ADMIN은 전사 권한이라 그대로 전 부서를 보고, TEAM_LEAD는 본인 소속 부서 +
 * scopeDepartmentId로 지정된 담당 부서까지만 보고 처리할 수 있게 좁혔다.
 */
export async function getApprovableDepartmentIds(approver: AuthUser): Promise<string[] | null> {
  if (approver.roles.includes('HR_ADMIN') || approver.roles.includes('SYSTEM_ADMIN')) return null; // null = 전 부서
  const scoped = await prisma.userRole.findMany({
    where: { userId: approver.userId, role: { code: 'TEAM_LEAD' }, scopeDepartmentId: { not: null } },
    select: { scopeDepartmentId: true },
  });
  return Array.from(new Set([approver.departmentId, ...scoped.map((r) => r.scopeDepartmentId as string)]));
}

approvalRouter.get('/requests', async (req, res) => {
  const status = (req.query.status as string) || 'PENDING';
  const departmentIds = await getApprovableDepartmentIds(req.authUser!);
  const requests = await prisma.approvalRequest.findMany({
    where: {
      status: status as any,
      ...(departmentIds ? { requester: { departmentId: { in: departmentIds } } } : {}),
    },
    include: {
      requester: true,
      leaveConversionRequest: true,
      attendanceCorrectionRequest: { include: { attendanceRecord: true } },
    },
    orderBy: { requestedAt: 'desc' },
  });
  return res.json({ success: true, data: requests });
});

const decisionSchema = z.object({ comment: z.string().optional() });

approvalRouter.post('/requests/:id/approve', async (req, res) => {
  const approverId = req.authUser!.userId;
  const { id } = req.params;
  const parsed = decisionSchema.safeParse(req.body);

  const request = await prisma.approvalRequest.findUnique({ where: { id }, include: { requester: { select: { departmentId: true } } } });
  if (!request) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.' } });
  if (request.status !== 'PENDING') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: '대기중 요청만 처리할 수 있습니다.' } });
  }
  const departmentIds = await getApprovableDepartmentIds(req.authUser!);
  if (departmentIds && !departmentIds.includes(request.requester.departmentId)) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '다른 부서의 요청은 처리할 권한이 없습니다.' } });
  }

  // 2026-09-08: 지난 근무일 퇴근 정정(주로 "위치이탈 자동감지"가 만든 제안)을 승인하면 결과적으로
  // 최소근무시간(정책값, 기본 8시간) 미만 근무로 확정되는 경우, /clock-out(수동 퇴근)과 똑같이
  // 사유 없이는 그냥 넘어가지 못하게 막았었다 — 승인권자가 코멘트(사유)를 입력해야만 승인할 수 있었음.
  // 2026-09-14: "퇴근 버튼을 못 눌러서" 올리는 정정 신청은 최소근무시간 미충족 자체가 이미 신청
  // 사유이므로, 승인권자가 매번 별도 승인사유를 또 입력하게 하는 게 불필요한 절차라는 요청으로
  // 이 강제 입력을 없앴다. 코멘트를 남기면 그 값을, 안 남기면 직원이 신청할 때 적은 사유를 그대로
  // 조기퇴근 사유로 남겨서 감사기록(audit)에는 계속 흔적이 남게 한다.
  let earlyLeaveReasonForCorrection: string | undefined;
  if (request.type === 'ATTENDANCE_CORRECTION' && request.attendanceCorrectionRequestId) {
    const correctionForCheck = await prisma.attendanceCorrectionRequest.findUnique({
      where: { id: request.attendanceCorrectionRequestId },
      include: { attendanceRecord: { select: { clockInAt: true } } },
    });
    // 2026-09-16: "오늘 퇴근 취소"(CANCEL_CLOCK_OUT)는 새 퇴근시각을 제안하는 게 아니라 기존
    // 퇴근을 아예 비우는 신청이라 proposedClockOutAt이 없다 — 최소근무시간 미달 여부를 따질
    // 대상 자체가 아니므로 이 검사는 MISSING_CLOCK_OUT일 때만 수행한다(안 그러면 null을
    // checkMinWorkedMinutes에 넘겨 승인 처리 자체가 에러로 죽는다).
    if (correctionForCheck?.type === 'MISSING_CLOCK_OUT' && correctionForCheck.attendanceRecord.clockInAt && correctionForCheck.proposedClockOutAt) {
      const { ok } = await checkMinWorkedMinutes(correctionForCheck.attendanceRecord.clockInAt, correctionForCheck.proposedClockOutAt);
      if (!ok) {
        earlyLeaveReasonForCorrection = (parsed.success ? parsed.data.comment : undefined) || correctionForCheck.reason || undefined;
      }
    }
  }

  // 2026-09-30 수정: 위의 "request.status !== 'PENDING'" 확인과 그 아래 실제 update 사이에는
  // 시간차가 있어서(레이스 컨디션), 같은 요청을 두 승인권자(또는 같은 승인권자가 두 번 빠르게
  // 클릭)가 거의 동시에 승인하면 둘 다 그 확인을 통과해버릴 수 있었다 — 그러면 휴가잔액이 두 번
  // 증가하거나(대체휴무 전환) 근태기록이 두 번 반영되는 등 중복 처리로 이어진다. updateMany의
  // where에 status: 'PENDING'을 넣어 DB가 원자적으로 "지금 PENDING인 것만" 갱신하게 해서, 두
  // 요청 중 하나만 count===1로 성공하고 나머지는 0으로 실패하게 만든다(ApprovalRequest에
  // 별도 버전/락 컬럼이 없어도 이 방식으로 동일한 효과를 낸다).
  const claim = await prisma.approvalRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'APPROVED', approverId, decidedAt: new Date(), comment: parsed.success ? parsed.data.comment : undefined },
  });
  if (claim.count === 0) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_DECIDED', message: '이미 다른 곳에서 처리된 요청입니다.' } });
  }
  const updated = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } });

  // 대체휴무/보상휴가 전환 승인인 경우, 휴가 잔여시간을 갱신한다.
  if (request.type === 'LEAVE_CONVERSION' && request.leaveConversionRequestId) {
    const conversion = await prisma.leaveConversionRequest.update({
      where: { id: request.leaveConversionRequestId },
      data: { status: 'APPROVED' },
    });
    const balance = await prisma.leaveBalance.upsert({
      where: { userId_leaveTypeId: { userId: conversion.userId, leaveTypeId: conversion.requestedLeaveTypeId } },
      update: { balanceMinutes: { increment: conversion.convertedMinutes } },
      create: { userId: conversion.userId, leaveTypeId: conversion.requestedLeaveTypeId, balanceMinutes: conversion.convertedMinutes },
    });
    await recordAuditLog({ actorUserId: approverId, actionType: 'APPROVE', targetType: 'leave_balance', targetId: balance.id, afterValue: balance });
  }

  // 지난 근무일 퇴근 정정 승인인 경우, 이때 비로소(=승인권자 확인 후) 근태 기록에 실제 반영한다.
  // 신청만으로는 절대 반영되지 않는다(직원 자기신고 + 승인권자 확인, 2단계를 모두 거쳐야 함).
  if (request.type === 'ATTENDANCE_CORRECTION' && request.attendanceCorrectionRequestId) {
    const applied = await applyAttendanceCorrection(request.attendanceCorrectionRequestId, earlyLeaveReasonForCorrection);
    if (applied) {
      await recordAuditLog({
        actorUserId: approverId,
        actionType: 'CORRECT',
        targetType: 'attendance_record',
        targetId: applied.updatedRecord.id,
        afterValue: { clockOutAt: applied.updatedRecord.clockOutAt, totalWorkedMinutes: applied.totalWorkedMinutes, correctionReason: applied.correction.reason },
      });
    }
  }

  await recordAuditLog({ actorUserId: approverId, actionType: 'APPROVE', targetType: 'approval_request', targetId: id, afterValue: updated });

  return res.json({ success: true, data: updated });
});

approvalRouter.post('/requests/:id/reject', async (req, res) => {
  const approverId = req.authUser!.userId;
  const { id } = req.params;
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.comment) {
    return res.status(400).json({ success: false, error: { code: 'COMMENT_REQUIRED', message: '반려 사유를 입력하세요.' } });
  }

  const request = await prisma.approvalRequest.findUnique({ where: { id }, include: { requester: { select: { departmentId: true } } } });
  if (!request) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.' } });
  if (request.status !== 'PENDING') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: '대기중 요청만 처리할 수 있습니다.' } });
  }
  const departmentIds = await getApprovableDepartmentIds(req.authUser!);
  if (departmentIds && !departmentIds.includes(request.requester.departmentId)) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '다른 부서의 요청은 처리할 권한이 없습니다.' } });
  }

  // 2026-09-30: approve와 동일한 이유로 원자적 조건부 갱신을 쓴다 — 동시에 승인/반려가 겹치면
  // 하나만 성공해야 한다.
  const claim = await prisma.approvalRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'REJECTED', approverId, decidedAt: new Date(), comment: parsed.data.comment },
  });
  if (claim.count === 0) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_DECIDED', message: '이미 다른 곳에서 처리된 요청입니다.' } });
  }
  const updated = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } });

  if (request.type === 'LEAVE_CONVERSION' && request.leaveConversionRequestId) {
    await prisma.leaveConversionRequest.update({ where: { id: request.leaveConversionRequestId }, data: { status: 'REJECTED' } });
  }
  if (request.type === 'ATTENDANCE_CORRECTION' && request.attendanceCorrectionRequestId) {
    await prisma.attendanceCorrectionRequest.update({ where: { id: request.attendanceCorrectionRequestId }, data: { status: 'REJECTED' } });
  }

  await recordAuditLog({ actorUserId: approverId, actionType: 'REJECT', targetType: 'approval_request', targetId: id, afterValue: updated });

  return res.json({ success: true, data: updated });
});
