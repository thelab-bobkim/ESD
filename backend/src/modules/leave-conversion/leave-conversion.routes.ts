import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';

export const leaveConversionRouter = Router();
leaveConversionRouter.use(requireAuth);

const requestSchema = z.object({ requestId: z.string().uuid() });

/** DRAFT 상태의 전환 후보를 정식 신청(PENDING)으로 전환하고 승인 워크플로우를 시작한다. */
leaveConversionRouter.post('/requests', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'requestId가 필요합니다.' } });
  }
  const userId = req.authUser!.userId;
  const draft = await prisma.leaveConversionRequest.findUnique({ where: { id: parsed.data.requestId } });
  if (!draft || draft.userId !== userId) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '전환 후보를 찾을 수 없습니다.' } });
  }
  if (draft.status !== 'DRAFT') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'DRAFT 상태만 신청할 수 있습니다.' } });
  }

  const updated = await prisma.leaveConversionRequest.update({ where: { id: draft.id }, data: { status: 'PENDING' } });
  const approval = await prisma.approvalRequest.create({
    data: {
      type: 'LEAVE_CONVERSION',
      referenceId: updated.id,
      requesterId: userId,
      leaveConversionRequestId: updated.id,
    },
  });

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'leave_conversion_request', targetId: updated.id, afterValue: { status: 'PENDING' } });

  return res.json({ success: true, data: { request: updated, approval } });
});

leaveConversionRouter.get('/requests/me', async (req, res) => {
  const userId = req.authUser!.userId;
  const requests = await prisma.leaveConversionRequest.findMany({
    where: { userId },
    include: { requestedLeaveType: true, approvalRequest: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ success: true, data: requests });
});
