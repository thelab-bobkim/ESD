import { createRouter } from '../../common/async-router';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { getPolicyNumber, getPolicyString } from '../../common/policy-engine/policy-engine';

export const nightWorkRouter = createRouter();
nightWorkRouter.use(requireAuth);

nightWorkRouter.post('/start', async (req, res) => {
  const userId = req.authUser!.userId;
  // 2026-09-30 수정(Medium): "진행중 세션 확인"과 "새 세션 생성"이 각각 따로 실행돼, 두 요청이
  // 거의 동시에 들어오면 둘 다 확인을 통과해 IN_PROGRESS 세션이 2개 생길 수 있었다(그러면 각각
  // 완료 처리되며 대체휴무 전환 후보도 2건 생성됨). Serializable 트랜잭션으로 확인~생성을 원자화한다.
  const session = await prisma.$transaction(
    async (tx) => {
      const inProgress = await tx.nightWorkSession.findFirst({ where: { userId, status: 'IN_PROGRESS' } });
      if (inProgress) return null;
      const created = await tx.nightWorkSession.create({
        data: { userId, startedAt: new Date(), status: 'IN_PROGRESS', note: req.body?.note },
      });
      await tx.statusChangeLog.create({ data: { userId, status: 'NIGHT_WORK', source: 'WEB' } });
      return created;
    },
    { isolationLevel: 'Serializable' }
  );
  if (!session) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_IN_PROGRESS', message: '이미 진행중인 야간근무가 있습니다.' } });
  }
  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'night_work_session', targetId: session.id, afterValue: session });
  return res.json({ success: true, data: session });
});

const endSchema = z.object({ sessionId: z.string().uuid() });

/**
 * 야간근무 종료 → 정책 엔진의 전환비율/보상방식을 조회하여
 * "대체휴무/보상휴가 전환 후보(DRAFT)"를 자동 생성한다.
 * 실제 확정 신청은 직원이 leave-conversion API로 별도 진행한다.
 */
nightWorkRouter.post('/end', async (req, res) => {
  const parsed = endSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'sessionId가 필요합니다.' } });
  }
  const userId = req.authUser!.userId;
  const session = await prisma.nightWorkSession.findUnique({ where: { id: parsed.data.sessionId } });
  if (!session || session.userId !== userId) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '야간근무 세션을 찾을 수 없습니다.' } });
  }
  if (session.status === 'COMPLETED') {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_COMPLETED', message: '이미 종료된 세션입니다.' } });
  }

  const endedAt = new Date();
  const workedMinutes = Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 60000));
  const updated = await prisma.nightWorkSession.update({
    where: { id: session.id },
    data: { endedAt, workedMinutes, status: 'COMPLETED' },
  });

  // 정책값 조회: 전환비율(N:M 형태, 기본 "1:1"), 보상방식(대체휴무/보상휴가/수당)
  const conversionRateStr = await getPolicyString('NIGHT_TO_LEAVE_CONVERSION_RATE', '1:1');
  const compensationType = await getPolicyString('NIGHT_WORK_COMPENSATION_TYPE', 'ALT_DAY_OFF');
  const [num, den] = conversionRateStr.split(':').map(Number);
  const ratio = num && den ? num / den : 1;
  const convertedMinutes = Math.round(workedMinutes * ratio);

  let leaveConversionCandidate = null;
  if (compensationType === 'ALT_DAY_OFF' || compensationType === 'COMP_LEAVE') {
    const leaveType = await prisma.leaveType.findUnique({ where: { code: compensationType } });
    if (leaveType) {
      leaveConversionCandidate = await prisma.leaveConversionRequest.create({
        data: {
          userId,
          sourceNightWorkSessionId: session.id,
          requestedLeaveTypeId: leaveType.id,
          convertedMinutes,
          status: 'DRAFT',
        },
      });
    }
  }

  await recordAuditLog({
    actorUserId: userId,
    actionType: 'STATUS_CHANGE',
    targetType: 'night_work_session',
    targetId: updated.id,
    beforeValue: { status: 'IN_PROGRESS' },
    afterValue: { status: 'COMPLETED', workedMinutes, leaveConversionCandidateId: leaveConversionCandidate?.id },
  });

  return res.json({ success: true, data: { session: updated, leaveConversionCandidate } });
});

nightWorkRouter.get('/me', async (req, res) => {
  const userId = req.authUser!.userId;
  const sessions = await prisma.nightWorkSession.findMany({ where: { userId }, orderBy: { startedAt: 'desc' }, take: 30 });
  return res.json({ success: true, data: sessions });
});
