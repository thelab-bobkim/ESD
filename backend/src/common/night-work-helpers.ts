import { prisma } from './prisma';
import { getPolicyString } from './policy-engine/policy-engine';

/**
 * 야간근무 시작~종료를 한 번에 기록한다("야간작업" 상세입력폼에서 시작/종료시간을 같이 넣는 경우).
 * 이미 진행중인 세션이 있으면 그 세션을 끝내고, 없으면 새로 만들어서 바로 완료 처리한다.
 * 완료되면 정책값(전환비율/보상방식)에 따라 대체휴무 전환 후보(DRAFT)를 자동 생성한다.
 * (night-work.routes.ts의 /start, /end 로직과 동일 — 상세입력폼 한 번의 제출로 통합한 버전)
 */
export async function recordNightWork(userId: string, startedAt: Date, endedAt: Date | null, note?: string) {
  let session = await prisma.nightWorkSession.findFirst({ where: { userId, status: 'IN_PROGRESS' } });
  if (!session) {
    session = await prisma.nightWorkSession.create({ data: { userId, startedAt, status: 'IN_PROGRESS', note } });
  }

  if (!endedAt) {
    // 종료시간 미입력 = 아직 진행중. 시작만 기록해두고 다음에 종료시간과 함께 다시 등록하면 완료 처리된다.
    return { session, leaveConversionCandidate: null };
  }

  const workedMinutes = Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 60000));
  const updated = await prisma.nightWorkSession.update({
    where: { id: session.id },
    data: { endedAt, workedMinutes, status: 'COMPLETED' },
  });

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
        data: { userId, sourceNightWorkSessionId: session.id, requestedLeaveTypeId: leaveType.id, convertedMinutes, status: 'DRAFT' },
      });
    }
  }

  return { session: updated, leaveConversionCandidate };
}
