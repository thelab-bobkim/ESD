import { createRouter } from '../../common/async-router';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';
import { todayDateOnly } from '../../common/attendance-helpers';

export const alertsRouter = createRouter();
alertsRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'));

/**
 * 예외 알림은 조회 시점에 정책값 기준으로 재계산해서 응답으로만 돌려준다(저장하지 않음 — MVP 단순화).
 * (2026-09-30: 예전 주석은 "alerts 테이블에 upsert"라고 적혀 있었지만 실제로는 저장하지 않는다 — 주석을 사실대로 고침.)
 * 운영 단계에서는 스케줄러(배치)로 주기 계산하는 것을 권장한다 (ARCHITECTURE.md 참조).
 */
alertsRouter.get('/', async (req, res) => {
  const now = new Date();

  const longWorkingThresholdMinutes = (await getPolicyNumber('OVERTIME_WARNING_THRESHOLD_HOURS', 12)) * 60;
  const unconfirmedThresholdMs = (await getPolicyNumber('UNCONFIRMED_STATUS_ALERT_MINUTES', 120)) * 60_000;

  const alerts: Array<{ ruleCode: string; userId: string; relatedId?: string; severity: 'INFO' | 'WARNING' | 'CRITICAL' }> = [];

  // 1) 미출근: 오늘 근무일인데 출근 기록이 없는 활성 직원 (RESIDENT/HQ_FIXED 대상, 정오 이후 기준 예시)
  // 2026-09-30 수정(L-9): 예전엔 UTC 달력일 기준이라 KST 00~09시에는 "어제" 기록을 오늘로 봤고,
  // 새벽 3시 근무일 경계와도 달랐다 — 다른 모든 화면과 같은 근무일(todayDateOnly)을 쓴다.
  const workDate = todayDateOnly();
  const activeUsers = await prisma.user.findMany({
    where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
  });
  const todayRecords = await prisma.attendanceRecord.findMany({ where: { workDate } });
  const clockedInIds = new Set(todayRecords.filter((r) => r.clockInAt).map((r) => r.userId));
  const kstHourNow = (now.getUTCHours() + 9) % 24;
  // 2026-09-30 수정(L-9): "정오 이후"를 KST로 정확히 판정한다(예전 getUTCHours()>=3은 KST 12시~다음날 08시로
  // 새벽에도 전원을 미출근으로 띄웠다). 근무일이 바뀌는 03시~정오 사이에는 미출근 알림을 내지 않는다.
  if (kstHourNow >= 12) {
    for (const u of activeUsers) {
      if (!clockedInIds.has(u.id)) {
        alerts.push({ ruleCode: 'NO_CLOCK_IN', userId: u.id, severity: 'WARNING' });
      }
    }
  }

  // 2) 장시간근무: 출근했으나 퇴근하지 않았고 경과시간이 임계값 초과
  for (const r of todayRecords) {
    if (r.clockInAt && !r.clockOutAt) {
      const elapsedMinutes = Math.round((now.getTime() - r.clockInAt.getTime()) / 60000);
      if (elapsedMinutes > longWorkingThresholdMinutes) {
        alerts.push({ ruleCode: 'LONG_WORKING', userId: r.userId, relatedId: r.id, severity: 'CRITICAL' });
      }
    }
  }

  // 3) 야간근무 후 미전환: 완료된 야간근무 중 전환요청이 없는 경우
  // 2026-09-30 수정(M-3): 예전엔 "완료된 세션 최신 100건"을 가져온 뒤 메모리에서 미전환만 골랐다 —
  // 이미 전환된 세션들이 100건을 채우면 정작 오래 방치된 미전환 건은 아예 조회되지 않아 알림이
  // 사라졌다. 조건(전환요청 없음)을 DB where로 내려서, 상한이 "미전환 건"에만 적용되게 한다.
  const unconvertedSessions = await prisma.nightWorkSession.findMany({
    where: { status: 'COMPLETED', leaveConversionRequest: { is: null } },
    orderBy: { endedAt: 'desc' },
    take: 500,
  });
  for (const s of unconvertedSessions) {
    alerts.push({ ruleCode: 'NIGHT_WORK_NOT_CONVERTED', userId: s.userId, relatedId: s.id, severity: 'WARNING' });
  }

  // 4) 지난 근무일 퇴근 미해결: 날짜가 넘어갔는데도 퇴근 처리가 안 된 채 방치된 기록.
  // 정정 신청(대기중 포함)이 이미 있으면 직원이 이미 조치 중이므로 중복 알림을 내지 않는다.
  // 하루의 경계는 자정이 아니라 새벽 3시(KST)이므로 반드시 todayDateOnly()를 써야 한다 —
  // 위 workDate(UTC 자정 기준)를 그대로 쓰면 새벽 3시 이전에는 하루 일찍 "미해결"로 오탐될 수 있다.
  const todayForCorrection = todayDateOnly();
  const staleOpenRecords = await prisma.attendanceRecord.findMany({
    where: { workDate: { lt: todayForCorrection }, clockInAt: { not: null }, clockOutAt: null },
    include: { correctionRequests: { where: { status: { in: ['PENDING', 'APPROVED'] } }, take: 1 } },
  });
  for (const r of staleOpenRecords) {
    if (r.correctionRequests.length === 0) {
      alerts.push({ ruleCode: 'PAST_DAY_UNRESOLVED_CLOCKOUT', userId: r.userId, relatedId: r.id, severity: 'WARNING' });
    }
  }

  // 5) 상태 미확인: 고객사 상주자의 마지막 확인시각이 임계값 초과
  // 2026-09-30 수정(M-3): 예전엔 "전사 최신 200건"에서 사용자별 최신 1건을 뽑았다 — 체크인이 잦은
  // 몇 명이 200건을 채우면 나머지 상주자는 통째로 빠져 "상태 미확인" 알림이 뜨지 않았다.
  // Postgres DISTINCT ON(Prisma distinct)으로 "사용자별 최신 1건"을 DB에서 바로 가져온다.
  const recentCheckins = await prisma.residentCheckin.findMany({
    distinct: ['userId'],
    orderBy: [{ userId: 'asc' }, { checkinAt: 'desc' }],
  });
  const latestByUser = new Map<string, (typeof recentCheckins)[number]>();
  for (const c of recentCheckins) latestByUser.set(c.userId, c);
  for (const [userId, c] of latestByUser) {
    if (now.getTime() - c.lastConfirmedAt.getTime() > unconfirmedThresholdMs) {
      alerts.push({ ruleCode: 'STATUS_NOT_CONFIRMED', userId, relatedId: c.id, severity: 'INFO' });
    }
  }

  return res.json({ success: true, data: alerts });
});
