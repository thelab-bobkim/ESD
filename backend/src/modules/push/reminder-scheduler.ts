import { prisma } from '../../common/prisma';
import { sendPushToUser, isPushConfigured } from '../../common/push';
import { todayDateOnly } from '../../common/attendance-helpers';

const CHECK_INTERVAL_MS = 60 * 1000; // 1분마다 "지금이 오전 9시인지" 확인
let lastSentDateKey: string | null = null; // 하루 중복 발송 방지(같은 프로세스 기준)

function isNineAmKST(now: Date): boolean {
  // 서버는 UTC 기준으로 도는 경우가 많아, KST(UTC+9)로 환산해서 09:00~09:04 사이인지 확인한다.
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMinute = now.getUTCMinutes();
  return kstHour === 9 && kstMinute < 5;
}

/**
 * 매일 오전 9시(KST)에, 그날 아직 출근시각이 안 찍힌 활성 직원 전원에게
 * "출근/재택 등 상태를 등록해주세요" 푸시 알림을 보낸다.
 * 다우오피스 동기화나 웹에서 직접 출근 관련 상태(본사근무/고객사상주/고객사미팅/고객사작업)를
 * 선택하면 attendance_records.clock_in_at이 자동으로 채워지므로, 그게 비어있으면 "아직 시작 안 함"이다.
 */
export function startClockInReminderScheduler() {
  setInterval(async () => {
    try {
      if (!isPushConfigured()) return;
      const now = new Date();
      if (!isNineAmKST(now)) return;

      const todayKey = todayDateOnly().toISOString().slice(0, 10);
      if (lastSentDateKey === todayKey) return; // 오늘 이미 보냈음
      lastSentDateKey = todayKey;

      const workDate = todayDateOnly();
      const activeUsers = await prisma.user.findMany({
        where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
        select: { id: true },
      });
      const todayRecords = await prisma.attendanceRecord.findMany({ where: { workDate }, select: { userId: true, clockInAt: true } });
      const clockedInIds = new Set(todayRecords.filter((r) => r.clockInAt).map((r) => r.userId));

      const targets = activeUsers.filter((u) => !clockedInIds.has(u.id));
      // eslint-disable-next-line no-console
      console.log(`[ClockInReminder] 오전 9시 미출근 알림 대상 ${targets.length}명`);

      for (const u of targets) {
        await sendPushToUser(u.id, {
          title: 'Tech Status Board',
          body: '아직 출근/재택 등 오늘 상태를 등록하지 않으셨어요. 지금 등록해주세요!',
          url: '/',
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ClockInReminder] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
