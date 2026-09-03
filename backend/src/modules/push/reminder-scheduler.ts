import { prisma } from '../../common/prisma';
import { sendPushToUser, isPushConfigured } from '../../common/push';
import { todayDateOnly } from '../../common/attendance-helpers';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

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
      }
      if (kstHour >= QUIET_HOUR_KST || kstHour < 9) return; // 조용한 시간대엔 아무것도 안 보낸다.

      const activeUsers = await prisma.user.findMany({
        where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
        select: { id: true },
      });
      const todayRecords = await prisma.attendanceRecord.findMany({
        where: { workDate },
        select: { userId: true, clockInAt: true, clockOutAt: true },
      });

      // 09시부터: 아직 출근 상태를 안 찍은 직원에게 5분마다 재알림.
      const clockedInIds = new Set(todayRecords.filter((r) => r.clockInAt).map((r) => r.userId));
      const clockInTargets = activeUsers.filter((u) => !clockedInIds.has(u.id));
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
            body: '아직 퇴근 등록을 안 하셨어요! 오늘 업무를 마치셨다면 퇴근 버튼을 눌러주세요. (등록 전까지 계속 알려드려요)',
            url: '/',
          });
        }
        if (clockOutSentCount > 0) {
          // eslint-disable-next-line no-console
          console.log(`[ClockOutReminder] 미퇴근 재알림 ${clockOutSentCount}명 발송`);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ClockReminder] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
