import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';

export const approvalRouter = Router();
approvalRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'));

approvalRouter.get('/requests', async (req, res) => {
  const status = (req.query.status as string) || 'PENDING';
  const requests = await prisma.approvalRequest.findMany({
    where: { status: status as any },
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

  const request = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!request) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.' } });
  if (request.status !== 'PENDING') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: '대기중 요청만 처리할 수 있습니다.' } });
  }

  const updated = await prisma.approvalRequest.update({
    where: { id },
    data: { status: 'APPROVED', approverId, decidedAt: new Date(), comment: parsed.success ? parsed.data.comment : undefined },
  });

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
    const correction = await prisma.attendanceCorrectionRequest.findUnique({
      where: { id: request.attendanceCorrectionRequestId },
      include: { attendanceRecord: { include: { breakSessions: true } } },
    });
    if (correction && correction.attendanceRecord.clockInAt) {
      // 체크에 쓴 것과 완전히 같은 경로(correction.attendanceRecord.clockInAt)에서 뽑아야
      // null-narrowing이 유지된다 — targetRecord.clockInAt처럼 다른 변수를 거쳐 접근하면
      // TypeScript가 별개의 경로로 보고 narrowing을 다시 잃어버린다(방금 겪은 문제).
      const clockInAt = correction.attendanceRecord.clockInAt;
      const targetRecord = correction.attendanceRecord;
      const totalBreakMinutes = targetRecord.breakSessions.reduce((sum, b) => {
        if (!b.endAt) return sum;
        return sum + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000);
      }, 0);
      const grossMinutes = Math.round((correction.proposedClockOutAt.getTime() - clockInAt.getTime()) / 60000);
      const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes);

      const updatedRecord = await prisma.attendanceRecord.update({
        where: { id: targetRecord.id },
        data: {
          clockOutAt: correction.proposedClockOutAt,
          totalWorkedMinutes,
          isCorrected: true,
          correctionReason: correction.reason,
        },
      });
      await prisma.attendanceCorrectionRequest.update({ where: { id: correction.id }, data: { status: 'APPROVED' } });
      await recordAuditLog({
        actorUserId: approverId,
        actionType: 'CORRECT',
        targetType: 'attendance_record',
        targetId: updatedRecord.id,
        afterValue: { clockOutAt: updatedRecord.clockOutAt, totalWorkedMinutes, correctionReason: correction.reason },
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

  const request = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!request) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.' } });
  if (request.status !== 'PENDING') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: '대기중 요청만 처리할 수 있습니다.' } });
  }

  const updated = await prisma.approvalRequest.update({
    where: { id },
    data: { status: 'REJECTED', approverId, decidedAt: new Date(), comment: parsed.data.comment },
  });

  if (request.type === 'LEAVE_CONVERSION' && request.leaveConversionRequestId) {
    await prisma.leaveConversionRequest.update({ where: { id: request.leaveConversionRequestId }, data: { status: 'REJECTED' } });
  }
  if (request.type === 'ATTENDANCE_CORRECTION' && request.attendanceCorrectionRequestId) {
    await prisma.attendanceCorrectionRequest.update({ where: { id: request.attendanceCorrectionRequestId }, data: { status: 'REJECTED' } });
  }

  await recordAuditLog({ actorUserId: approverId, actionType: 'REJECT', targetType: 'approval_request', targetId: id, afterValue: updated });

  return res.json({ success: true, data: updated });
});
