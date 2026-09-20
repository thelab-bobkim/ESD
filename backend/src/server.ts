import 'dotenv/config';
import { createApp } from './app';
import { startDauofficeScheduler } from './modules/dauoffice/dauoffice-scheduler';
import { startLeaveScrapeScheduler } from './modules/dauoffice/leave-scrape-scheduler';
import { startClockInReminderScheduler } from './modules/push/reminder-scheduler';
import { startMismatchCoordPurgeScheduler } from './modules/push/mismatch-coord-purge-scheduler';
import { ensureAuditorRole } from './common/ensure-roles';

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[employee-status-backend] listening on port ${PORT}`);
});

// 2026-09-20: AUDITOR 역할 행이 없으면 만들어둔다(common/ensure-roles.ts 참고) — 다른 스케줄러보다
// 먼저(적어도 요청과 경합하지 않게) 실행되도록 최상단에 둔다.
ensureAuditorRole().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[EnsureRoles] AUDITOR 역할 생성 실패:', err);
});

startDauofficeScheduler();
startLeaveScrapeScheduler();
startClockInReminderScheduler();
startMismatchCoordPurgeScheduler();
