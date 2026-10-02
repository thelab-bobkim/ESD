import { prisma } from '../../common/prisma';
import { sendPushToUser, isPushConfigured } from '../../common/push';
import { todayDateOnly, realDayWindow, isWeekendKST, isPublicHolidayKST, PROVISIONAL_HQ_NOTE } from '../../common/attendance-helpers';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

// 2026-09-14: "주말/공휴일에도 출근 알림이 계속 온다"는 신고(김진호·김진영·권성주) 반영 — 주말은
// "주말작업"만 등록 가능한 선택사항이라 굳이 출근을 강요할 이유가 없고, 공휴일도 마찬가지다.
// 휴가/대체휴무는 여러 날에 걸쳐도 그 기간 매일 다시 아이콘을 누르지 않는 게 보통이라(휴가 시작일에
// 한 번만 등록), "오늘" 로그가 아니라 "최근 상태"가 여전히 휴가/대체휴무인지로 판단한다(박준영 피드백).
const NO_CLOCK_IN_REMINDER_STATUSES = new Set(['ON_LEAVE', 'ALT_DAY_OFF']);
// 휴가/대체휴무는 길어야 보통 2주 이내이므로, 그보다 훨씬 예전 로그까지 뒤질 필요는 없다 —
// 매분 도는 스케줄러라 조회 범위를 넉넉히 잡아도 좁혀두는 편이 안전하다.
const LEAVE_STATUS_LOOKBACK_DAYS = 14;

const CHECK_INTERVAL_MS = 60 * 1000; // 1분마다 "지금이 알림 보낼 시각인지" 확인
// 2026-09-03: 하루 한 번만 보내고 끝나던 걸, 등록할 때까지 계속 다시 알려주는 방식으로 바꿨다
// (미출근/미퇴근이 워낙 많아서 한 번의 알림으로는 안 통했다는 판단 — 사용자 확인 완료).
const ESCALATION_INTERVAL_MS = 5 * 60 * 1000; // 미등록 상태가 계속되면 이 간격으로 재알림
// 자정 넘어서까지 5분마다 폰을 울리면 오히려 민폐이자 "알림 꺼버리기"로 이어질 수 있어서,
// 이 시각(KST) 이후로는 그날의 재알림을 멈춘다. 다음날 출근 알림은 09시에 새로 시작된다.
const QUIET_HOUR_KST = 22;

// userId -> 그 알림을 마지막으로 보낸 시각(ms). workDate(새벽 3시 기준 하루)가 바뀌면 통째로
// 비워서 새 하루엔 처음부터 다시 알림이 나가게 한다. 서버 재시작 시에도 초기화되는데, 이 경우
// 재시작 직후 한 번 더 나갈 수 있지만 최악의 경우 하루 넘게 조용해지는 것보다는 낫다고 판단.
let lastClockInSentAt = new Map<string, number>();
let lastClockOutSentAt = new Map<string, number>();
// 2026-09-04: "이동중" 상태로 도착체크 팝업(GPS 기반, 앱을 열어놔야 뜬다)을 놓치는 직원이 많다는
// 신고 — 이동중 상태가 너무 오래 지속되면(=도착했는데 상태를 안 바꿨을 가능성) 팝업과 별개로
// 푸시 알림도 보낸다. 앱을 안 열어놔도 알림이 오므로 "인지를 못 한다"는 문제를 보완한다.
let lastStaleTransitSentAt = new Map<string, number>();
// 2026-09-04: 고객사작업/고객사미팅은 "우선 등록, 세부내용은 나중에" 원칙상 아이콘을 누르는
// 즉시 상태만 등록되고(note가 비어있음) 그 아래 열리는 입력폼을 따로 제출해야 고객사명·업무내용이
// 채워진다 — 그리고 이 두 상태는 그 입력폼을 제출하는 순간에야 위치대조(GPS)도 함께 이뤄지므로,
// 폼을 안 채우고 방치하면 상황판에 "위치 미확인"만 계속 남고 내용도 비어보인다.
// (관리자 문의: "고객사 정보 없이 등록된 사람이 있다 / 왜 위치 미확인이 안 없어지냐") 이동중과
// 같은 방식으로, 등록만 되고 세부내용이 빈 채로 정책값(기본 20분) 이상 지나면 재알림한다.
// 본사근무는 여기서 뺐다 — 위치대조가 등록 즉시 이뤄져 "위치 미확인"과는 무관하고, 부서별 설정
// (frontend index.tsx DEPARTMENT_STATUS_OVERRIDES)에 따라 세부폼 자체가 없는 부서도 있어서
// "세부내용 미입력"을 문제로 볼 수 없기 때문이다.
const PENDING_DETAIL_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);
const PENDING_DETAIL_LABELS: Record<string, string> = {
  CLIENT_MEETING: '고객사미팅',
  CLIENT_WORK: '고객사작업',
};
let lastPendingDetailSentAt = new Map<string, number>();
// 2026-10-02: "출근" 버튼만 누르고 실제 근무형태(본사근무/고객사작업 등)를 직접 고르지 않아
// 잠정(PROVISIONAL_HQ_NOTE) 본사근무로 남아있는 채 방치되는 경우(손지원·임규동 사례) — 관리자
// 상황판의 "지금 확인이 필요한 직원" 목록에 계속 떠서 관리자 문의로 발견했다. 세부내용 미입력
// 알림(PENDING_DETAIL)과 같은 패턴으로, 본인에게 먼저 확정을 재촉하는 게 근본 해결책이다.
let lastProvisionalSentAt = new Map<string, number>();
let trackedDateKey: string | null = null;

function kstHourOf(now: Date): number {
  return (now.getUTCHours() + 9) % 24;
}

/** 정책값(CLOCKOUT_REMINDER_HOUR, 기본 18시=오후6시) */
async function clockOutReminderStartHourKST(): Promise<number> {
  return getPolicyNumber('CLOCKOUT_REMINDER_HOUR', 18);
}

/**
 * 매일 오전 9시(KST)부터, 그날 아직 출근시각이 안 찍힌 활성 직원에게 "출근/재택 등 상태를
 * 등록해주세요" 푸시 알림을 5분 간격으로 등록할 때까지 반복해서 보낸다(밤 10시 이후는 조용히).
 * 다우오피스 동기화나 웹에서 직접 출근 관련 상태(본사근무/고객사상주/고객사미팅/고객사작업)를
 * 선택하면 attendance_records.clock_in_at이 자동으로 채워지므로, 그게 비어있으면 "아직 시작 안 함"이다.
 *
 * 또한 정책값으로 정한 저녁 시각(기본 오후 6시)부터, 그날 출근은 했지만 아직 퇴근을 안 누른
 * 직원에게도 같은 방식(5분 간격, 밤 10시까지)으로 "퇴근 등록해주세요" 알림을 보낸다.
 *
 * 세 번째로, 그날 가장 최근 상태가 "이동중"(MOVING)인 채로 정책값(기본 30분) 이상 지난 직원에게도
 * 같은 방식으로 재알림한다 — GPS 도착 감지 팝업은 앱을 열어놔야만 뜨기 때문에, 이동중 상태로
 * 도착한 뒤 앱을 안 보고 있으면 본인이 알아챌 방법이 없다는 문제를 보완하기 위함이다.
 *
 * 네 번째로, 그날 가장 최근 상태가 고객사작업/고객사미팅인데 세부내용(고객사·업무내용 등)을
 * 아직 입력하지 않은 채로 정책값(기본 20분) 이상 지난 직원에게도 재알림한다 — 이 두 상태는
 * "우선 등록, 세부내용은 나중에" 원칙상 아이콘을 누르는 즉시 등록되고, 위치대조는 그 아래 열리는
 * 입력폼을 실제로 제출하는 순간에야 이뤄진다. 그래서 폼을 안 채우고 방치하면 상황판 관리자
 * 화면에 고객사/업무내용 없이 "위치 미확인"만 계속 남게 되는데, 이 알림이 그 상태를 인지시켜준다.
 *
 * 다섯 번째로, "출근" 버튼만 누르고 실제 근무형태(본사근무/고객사작업 등)를 직접 고르지 않아
 * 잠정 본사근무(PROVISIONAL_HQ_NOTE)로 남은 채 정책값(기본 20분) 이상 지난 직원에게도 같은
 * 방식으로 재알림한다 — 이 상태는 관리자 상황판의 "지금 확인이 필요한 직원" 목록에 "확인
 * 대기중"으로 계속 남는데(손지원·임규동 사례), 이 알림이 본인에게 먼저 확정을 재촉해 근본
 * 원인을 해소한다(2026-10-02, 관리자 상황판 그레이스타임 적용과 함께 도입).
 */
export function startClockInReminderScheduler() {
  setInterval(async () => {
    try {
      if (!isPushConfigured()) return;
      const now = new Date();
      const kstHour = kstHourOf(now);
      const workDate = todayDateOnly();
      const todayKey = workDate.toISOString().slice(0, 10);

      // 하루(새벽 3시 기준)가 바뀌면 그날의 발송기록을 초기화한다.
      if (trackedDateKey !== todayKey) {
        trackedDateKey = todayKey;
        lastClockInSentAt = new Map();
        lastClockOutSentAt = new Map();
        lastStaleTransitSentAt = new Map();
        lastPendingDetailSentAt = new Map();
        lastProvisionalSentAt = new Map();
      }
      if (kstHour >= QUIET_HOUR_KST || kstHour < 9) return; // 조용한 시간대엔 아무것도 안 보낸다.
      // 2026-09-14: 주말/공휴일엔 출근을 강요할 이유가 없으므로 이 틱 자체를 조용히 건너뛴다
      // (미출근/미퇴근/이동중 장시간/세부내용 미입력 알림 전부 포함).
      if (isWeekendKST(now) || (await isPublicHolidayKST(now))) return;

      const activeUsers = await prisma.user.findMany({
        where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
        select: { id: true },
      });
      const todayRecords = await prisma.attendanceRecord.findMany({
        where: { workDate },
        select: { userId: true, clockInAt: true, clockOutAt: true },
      });

      // 09시부터: 아직 출근 상태를 안 찍은 직원에게 5분마다 재알림. 다만 휴가/대체휴무 중인
      // 직원은 애초에 오늘 출근할 계획이 없으므로 대상에서 뺀다(박준영 피드백, 2026-09-14) —
      // 휴가는 시작일에 한 번만 등록하는 경우가 많아 "오늘" 로그가 아니라 "최근 상태"를 본다.
      const clockedInIds = new Set(todayRecords.filter((r) => r.clockInAt).map((r) => r.userId));
      const notClockedInUsers = activeUsers.filter((u) => !clockedInIds.has(u.id));
      const leaveLookbackStart = new Date(now.getTime() - LEAVE_STATUS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const recentLogsForLeaveCheck = notClockedInUsers.length > 0
        ? await prisma.statusChangeLog.findMany({
            where: { userId: { in: notClockedInUsers.map((u) => u.id) }, changedAt: { gte: leaveLookbackStart } },
            orderBy: { changedAt: 'desc' },
            select: { userId: true, status: true },
          })
        : [];
      const latestOverallStatusByUser = new Map<string, string>();
      for (const log of recentLogsForLeaveCheck) {
        if (!latestOverallStatusByUser.has(log.userId)) latestOverallStatusByUser.set(log.userId, log.status);
      }
      const clockInTargets = notClockedInUsers.filter((u) => !NO_CLOCK_IN_REMINDER_STATUSES.has(latestOverallStatusByUser.get(u.id) ?? ''));
      let clockInSentCount = 0;
      for (const u of clockInTargets) {
        const last = lastClockInSentAt.get(u.id);
        if (last && now.getTime() - last < ESCALATION_INTERVAL_MS) continue;
        lastClockInSentAt.set(u.id, now.getTime());
        clockInSentCount++;
        await sendPushToUser(u.id, {
          title: 'DSTI-TSB',
          body: '아직 출근/재택 등 오늘 상태를 등록하지 않으셨어요. 지금 등록해주세요! (등록 전까지 계속 알려드려요)',
          url: '/',
        });
      }
      if (clockInSentCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ClockInReminder] 미출근 재알림 ${clockInSentCount}명 발송`);
      }

      // 정책시각(기본 18시)부터: 출근은 했는데 아직 퇴근을 안 누른 직원에게 5분마다 재알림.
      const clockOutStartHour = await clockOutReminderStartHourKST();
      if (kstHour >= clockOutStartHour) {
        const clockOutTargets = todayRecords.filter((r) => r.clockInAt && !r.clockOutAt);
        let clockOutSentCount = 0;
        for (const r of clockOutTargets) {
          const last = lastClockOutSentAt.get(r.userId);
          if (last && now.getTime() - last < ESCALATION_INTERVAL_MS) continue;
          lastClockOutSentAt.set(r.userId, now.getTime());
          clockOutSentCount++;
          await sendPushToUser(r.userId, {
            title: 'DSTI-TSB',
            // 2026-09-06: 계속 근무 중(야간작업으로 이어감)이라 퇴근을 미루는 경우가 있어서, 그런
            // 경우에도 일단 퇴근으로 정규 근무를 마감해야 이 알림이 멈춘다는 걸 같이 안내한다.
            body: '아직 퇴근 등록을 안 하셨어요! 업무를 마치셨다면 퇴근 버튼을 눌러주세요. 계속 근무(야간작업)하실 계획이어도 우선 퇴근으로 정규 근무를 마감해야 이 알림이 멈춰요. (등록 전까지 계속 알려드려요)',
            url: '/',
          });
        }
        if (clockOutSentCount > 0) {
          // eslint-disable-next-line no-console
          console.log(`[ClockOutReminder] 미퇴근 재알림 ${clockOutSentCount}명 발송`);
        }
      }

      // 2026-09-04: "이동중" 상태가 정책값(기본 30분) 이상 그대로면, 도착 후 상태를 안 바꾼
      // 것으로 보고 5분마다 재알림한다. GPS 도착 팝업(index.tsx)은 앱을 열어놔야만 뜨므로,
      // 이 푸시 알림이 앱을 안 보고 있는 직원에게 "상태를 확인해달라"고 알려주는 보완책이다.
      const staleTransitMinutes = await getPolicyNumber('STALE_TRANSIT_REMINDER_MINUTES', 30);
      const { start: dayStart, end: dayEnd } = realDayWindow(workDate);
      const dayLogs = await prisma.statusChangeLog.findMany({
        where: { changedAt: { gte: dayStart, lt: dayEnd }, userId: { in: activeUsers.map((u: { id: string }) => u.id) } },
        orderBy: { changedAt: 'asc' },
        select: { userId: true, status: true, changedAt: true, note: true },
      });
      // 오름차순으로 순회하며 계속 덮어쓰면, 각 유저별로 마지막에 남는 값이 "오늘 가장 최근 상태"가 된다.
      const latestStatusByUser = new Map<string, { status: string; changedAt: Date; note: string | null }>();
      for (const log of dayLogs) {
        latestStatusByUser.set(log.userId, { status: log.status, changedAt: log.changedAt, note: log.note });
      }
      let staleTransitSentCount = 0;
      for (const u of activeUsers) {
        const latest = latestStatusByUser.get(u.id);
        if (!latest || latest.status !== 'MOVING') continue;
        if (now.getTime() - latest.changedAt.getTime() < staleTransitMinutes * 60 * 1000) continue;
        const last = lastStaleTransitSentAt.get(u.id);
        if (last && now.getTime() - last < ESCALATION_INTERVAL_MS) continue;
        lastStaleTransitSentAt.set(u.id, now.getTime());
        staleTransitSentCount++;
        await sendPushToUser(u.id, {
          title: 'DSTI-TSB',
          body: `이동중 상태가 ${staleTransitMinutes}분 넘게 계속되고 있어요. 도착하셨다면 상태를 업데이트해주세요! (등록 전까지 계속 알려드려요)`,
          url: '/',
        });
      }
      if (staleTransitSentCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[StaleTransitReminder] 이동중 장시간 재알림 ${staleTransitSentCount}명 발송`);
      }

      // 2026-09-04: 본사근무/고객사작업/고객사미팅으로 등록만 되고 세부내용(고객사·업무내용 등)을
      // 아직 안 채운 채로 정책값(기본 20분) 이상 지나면 재알림한다 — 이 세 상태는 세부내용 입력폼을
      // 제출해야만 위치대조도 함께 이뤄지므로, 이 알림이 결국 "위치 미확인" 문제도 같이 해소해준다.
      const pendingDetailMinutes = await getPolicyNumber('PENDING_DETAIL_REMINDER_MINUTES', 20);
      let pendingDetailSentCount = 0;
      for (const u of activeUsers) {
        const latest = latestStatusByUser.get(u.id);
        if (!latest || !PENDING_DETAIL_STATUSES.has(latest.status)) continue;
        if (latest.note && latest.note.trim()) continue;
        if (now.getTime() - latest.changedAt.getTime() < pendingDetailMinutes * 60 * 1000) continue;
        const last = lastPendingDetailSentAt.get(u.id);
        if (last && now.getTime() - last < ESCALATION_INTERVAL_MS) continue;
        lastPendingDetailSentAt.set(u.id, now.getTime());
        pendingDetailSentCount++;
        const label = PENDING_DETAIL_LABELS[latest.status] ?? latest.status;
        await sendPushToUser(u.id, {
          title: 'DSTI-TSB',
          body: `'${label}'(으)로 등록만 되고 고객사·업무내용을 아직 입력하지 않으셨어요. 앱에서 마저 입력해주세요 — 위치 확인도 그때 함께 이뤄져요! (등록 전까지 계속 알려드려요)`,
          url: '/',
        });
      }
      if (pendingDetailSentCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[PendingDetailReminder] 세부내용 미입력 재알림 ${pendingDetailSentCount}명 발송`);
      }

      // 2026-10-02: "출근" 버튼만 누르고 실제 근무형태(본사근무/고객사작업 등)를 직접 고르지
      // 않아 잠정 본사근무(PROVISIONAL_HQ_NOTE)로 남은 채 정책값(기본 20분) 이상 지나면
      // 재알림한다 — 위에서 이미 계산해둔 latestStatusByUser를 재사용한다(고객사 세부내용
      // 미입력 알림과 동일한 패턴). 관리자 상황판의 "확인 대기중" 카드가 계속 남는 문제의
      // 근본 원인을 본인에게 먼저 알려 해소를 유도한다.
      const provisionalMinutes = await getPolicyNumber('PROVISIONAL_STATUS_REMINDER_MINUTES', 20);
      let provisionalSentCount = 0;
      for (const u of activeUsers) {
        const latest = latestStatusByUser.get(u.id);
        if (!latest || latest.status !== 'HQ_WORKING' || latest.note !== PROVISIONAL_HQ_NOTE) continue;
        if (now.getTime() - latest.changedAt.getTime() < provisionalMinutes * 60 * 1000) continue;
        const last = lastProvisionalSentAt.get(u.id);
        if (last && now.getTime() - last < ESCALATION_INTERVAL_MS) continue;
        lastProvisionalSentAt.set(u.id, now.getTime());
        provisionalSentCount++;
        await sendPushToUser(u.id, {
          title: 'DSTI-TSB',
          body: '출근 버튼만 누르고 오늘 실제 근무형태(본사근무/고객사작업 등)를 아직 고르지 않으셨어요. 앱에서 상태를 확정해주세요! (등록 전까지 계속 알려드려요)',
          url: '/',
        });
      }
      if (provisionalSentCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ProvisionalStatusReminder] 확인 대기중 재알림 ${provisionalSentCount}명 발송`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ClockReminder] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
