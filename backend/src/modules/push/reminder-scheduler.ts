import { prisma } from '../../common/prisma';
import { sendPushToUser, isPushConfigured } from '../../common/push';
import { todayDateOnly } from '../../common/attendance-helpers';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

const CHECK_INTERVAL_MS = 60 * 1000; // 1분마다 "지금이 알림 보낼 시각인지" 확인
let lastClockInSentDateKey: string | null = null; // 하루 중복 발송 방지(같은 프로세스 기준)
let lastClockOutSentDateKey: string | null = null;

function isNineAmKST(now: Date): boolean {
  // 서버는 UTC 기준으로 도는 경우가 많아, KST(UTC+9)로 환산해서 09:00~09:04 사이인지 확인한다.
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMinute = now.getUTCMinutes();
  return kstHour === 9 && kstMinute < 5;
}

/** 정책값(CLOCKOUT_REMINDER_HOUR, 기본 18시=오후6시)으로 설정한 시각의 00~04분 사이인지 확인한다. */
async function isClockOutReminderTimeKST(now: Date): Promise<boolean> {
  const targetHour = await getPolicyNumber('CLOCKOUT_REMINDER_HOUR', 18);
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMinute = now.getUTCMinutes();
  return kstHour === targetHour && kstMinute < 5;
}

/**
 * 매일 오전 9시(KST)에, 그날 아직 출근시각이 안 찍힌 활성 직원 전원에게
 * "출근/재택 등 상태를 등록해주세요" 푸시 알림을 보낸다.
 * 다우오피스 동기화나 웹에서 직접 출근 관련 상태(본사근무/고객사상주/고객사미팅/고객사작업)를
 * 선택하면 attendance_records.clock_in_at이 자동으로 채워지므로, 그게 비어있으면 "아직 시작 안 함"이다.
 *
 * 또한 정책값으로 정한 저녁 시각(기본 오후 6시)에, 그날 출근은 했지만 아직 퇴근을 안 누른
 * 직원들에게도 "퇴근 등록해주세요" 알림을 보낸다 — 계속 "진행중"으로 방치되는 걸 막기 위함.
 */
export function startClockInReminderScheduler() {
  setInterval(async () => {
    try {
      if (!isPushConfigured()) return;
      const now = new Date();
      const workDate = todayDateOnly();
      const todayKey = workDate.toISOString().slice(0, 10);

      const activeUsers = await prisma.user.findMany({
        where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
        select: { id: true },
      });
      const todayRecords = await prisma.attendanceRecord.findMany({
        where: { workDate },
        select: { userId: true, clockInAt: true, clockOutAt: true },
      });

      if (isNineAmKST(now) && lastClockInSentDateKey !== todayKey) {
        lastClockInSentDateKey = todayKey;
        const clockedInIds = new Set(todayRecords.filter((r) => r.clockInAt).map((r) => r.userId));
        const targets = activeUsers.filter((u) => !clockedInIds.has(u.id));
        // eslint-disable-next-line no-console
        console.log(`[ClockInReminder] 오전 9시 미출근 알림 대상 ${targets.length}명`);
        for (const u of targets) {
          await sendPushToUser(u.id, {
            title: 'DSTI-TSB',
            body: '아직 출근/재택 등 오늘 상태를 등록하지 않으셨어요. 지금 등록해주세요!',
            url: '/',
          });
        }
      }

      if ((await isClockOutReminderTimeKST(now)) && lastClockOutSentDateKey !== todayKey) {
        lastClockOutSentDateKey = todayKey;
        // 출근은 했는데 아직 퇴근을 안 누른 사람만 대상으로 한다.
        const targets = todayRecords.filter((r) => r.clockInAt && !r.clockOutAt);
        // eslint-disable-next-line no-console
        console.log(`[ClockOutReminder] 저녁 미퇴근 알림 대상 ${targets.length}명`);
        for (const r of targets) {
          await sendPushToUser(r.userId, {
            title: 'DSTI-TSB',
            body: '아직 퇴근 등록을 안 하셨어요! 오늘 업무를 마치셨다면 퇴근 버튼을 눌러주세요.',
            url: '/',
          });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ClockReminder] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
