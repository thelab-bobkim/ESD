import { createRouter } from '../../common/async-router';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';

export const leaveConversionRouter = createRouter();
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

  // 2026-09-30 수정(Medium): 위의 "DRAFT 확인"과 아래 update 사이에 시간차가 있어, 같은 후보를
  // 두 번 빠르게 신청하면(DRAFT를 둘 다 통과) ApprovalRequest가 2건 생기고 승인도 2번 이뤄져
  // 휴가 잔액이 2배로 늘어날 수 있었다 — updateMany의 where에 status:'DRAFT'를 넣어 DB가
  // 원자적으로 "지금 DRAFT인 것만" 전환하게 하고, 하나의 트랜잭션으로 승인요청 생성까지 묶는다.
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.leaveConversionRequest.updateMany({
      where: { id: draft.id, status: 'DRAFT' },
      data: { status: 'PENDING' },
    });
    if (claim.count === 0) return null;
    const updated = await tx.leaveConversionRequest.findUniqueOrThrow({ where: { id: draft.id } });
    const approval = await tx.approvalRequest.create({
      data: {
        type: 'LEAVE_CONVERSION',
        referenceId: updated.id,
        requesterId: userId,
        leaveConversionRequestId: updated.id,
      },
    });
    await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'leave_conversion_request', targetId: updated.id, afterValue: { status: 'PENDING' } }, tx);
    return { request: updated, approval };
  });

  if (!result) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_REQUESTED', message: '이미 신청된 전환 후보입니다.' } });
  }

  return res.json({ success: true, data: result });
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
