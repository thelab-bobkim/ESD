import { prisma } from './prisma';
import { getPolicyString } from './policy-engine/policy-engine';

// 2026-09-18: EffortLog(effort-helpers.ts)와 같은 이유로 필요해진 재저장 판단 — 이미 완료
// 처리된 세션이라도 같은 시작~종료 시각으로 다시 등록되면(내용만 고쳐서 재저장한 것으로 판단)
// 새 세션을 또 만들지 않는다. 그대로 두면 저장 버튼을 다시 누를 때마다 대체휴무 전환 후보
// (LeaveConversionRequest)까지 중복 생성되어 실제 보상휴가가 부풀려질 수 있다 — 단순 표시 문제인
// EffortLog 쪽보다 오히려 더 심각한 경우. NightWorkSession에는 등록시각(createdAt) 컬럼이 없어
// EffortLog처럼 "최근 N시간 이내"로 창을 두진 못하지만, 시작·종료 시각이 초 단위까지 완전히
// 같은 두 세션이 실제로는 서로 다른 근무인 경우는 사실상 없다고 봐도 안전하다.
async function findResubmitTarget(userId: string, startedAt: Date, endedAt: Date | null) {
  const inProgress = await prisma.nightWorkSession.findFirst({ where: { userId, status: 'IN_PROGRESS' } });
  if (inProgress) return inProgress;
  if (!endedAt) return null;
  return prisma.nightWorkSession.findFirst({
    where: { userId, startedAt, endedAt, status: 'COMPLETED' },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * 야간근무 시작~종료를 한 번에 기록한다("야간작업" 상세입력폼에서 시작/종료시간을 같이 넣는 경우).
 * 이미 진행중인 세션이 있으면 그 세션을 끝내고, 없으면 새로 만들어서 바로 완료 처리한다.
 * 완료되면 정책값(전환비율/보상방식)에 따라 대체휴무 전환 후보(DRAFT)를 자동 생성한다.
 * (night-work.routes.ts의 /start, /end 로직과 동일 — 상세입력폼 한 번의 제출로 통합한 버전)
 */
export async function recordNightWork(userId: string, startedAt: Date, endedAt: Date | null, note?: string) {
  let session = await findResubmitTarget(userId, startedAt, endedAt);
  // 이미 완료 처리된 세션을 그대로 재저장하는 경우 — 시간·전환후보는 그대로 두고 메모만 갱신한다
  // (아래에서 다시 완료 처리 로직을 타면 전환후보가 또 생기므로 여기서 바로 끝낸다).
  if (session && session.status === 'COMPLETED') {
    const updated = await prisma.nightWorkSession.update({ where: { id: session.id }, data: { note } });
    return { session: updated, leaveConversionCandidate: null, workedMinutes: updated.workedMinutes ?? undefined, altDayOffRecommended: false };
  }
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

  // 포괄임금제 대상 본사 인력: 저녁 9시 이후 시작해서 6시간 이상 근무했으면 대체휴무를 권고한다.
  // 시스템이 조용히 자동 처리하지는 않는다(근로기준법상 보상휴가는 근로자 동의가 필요) —
  // 대신 직원에게 즉시 알려주고, 본인이 확인 버튼 한 번으로 확정하게 한다.
  const startHourKST = (session.startedAt.getUTCHours() + 9) % 24;
  const altDayOffRecommended = startHourKST >= 21 && workedMinutes >= 6 * 60;

  return { session: updated, leaveConversionCandidate, workedMinutes, altDayOffRecommended };
}

/**
 * 이 등록이 새 세션을 만드는 대신 기존 세션(진행중이든, 이미 완료된 걸 재저장하는 것이든)을 그대로
 * 갱신하게 될지, 부작용 없이 미리 확인한다. attendance.routes.ts가 상태변경 로그(StatusChangeLog)를
 * 새로 남길지 그대로 갱신할지 판단하는 데 쓴다(effort-helpers.ts willUpdateExistingEffort와 동일한 목적).
 */
export async function willResumeNightWork(userId: string, startedAt: Date, endedAt: Date | null): Promise<boolean> {
  return (await findResubmitTarget(userId, startedAt, endedAt)) !== null;
}
