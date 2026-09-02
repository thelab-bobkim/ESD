import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole, type AuthUser } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { applyAttendanceCorrection } from '../../common/attendance-helpers';

export const approvalRouter = Router();
approvalRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'));

/**
 * 2026-08-30 보안점검: 예전엔 TEAM_LEAD 역할만 있으면 부서 상관없이 아무 요청이나 조회/승인/반려할
 * 수 있었다(UserRole.scopeDepartmentId가 스키마에 있는데도 실제로는 어디서도 쓰이지 않았음).
 * HR_ADMIN/SYSTEM_ADMIN은 전사 권한이라 그대로 전 부서를 보고, TEAM_LEAD는 본인 소속 부서 +
 * scopeDepartmentId로 지정된 담당 부서까지만 보고 처리할 수 있게 좁혔다.
 */
async function getApprovableDepartmentIds(approver: AuthUser): Promise<string[] | null> {
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
    const applied = await applyAttendanceCorrection(request.attendanceCorrectionRequestId);
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
