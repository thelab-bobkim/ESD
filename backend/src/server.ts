import 'dotenv/config';
import { createApp } from './app';
import { startDauofficeScheduler } from './modules/dauoffice/dauoffice-scheduler';
import { startLeaveScrapeScheduler } from './modules/dauoffice/leave-scrape-scheduler';
import { startClockInReminderScheduler } from './modules/push/reminder-scheduler';
import { startMismatchCoordPurgeScheduler } from './modules/push/mismatch-coord-purge-scheduler';
import { ensureAuditorRole } from './common/ensure-roles';
import { ensureDbConstraints } from './common/ensure-db-constraints';
import { dauofficeSchedulersEnabled } from './common/feature-flags';

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

// 2026-09-30(M-14): NULL 복합유니크 구멍을 부분 유니크 인덱스로 막는다(멱등, common/ensure-db-constraints.ts).
ensureDbConstraints().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[EnsureDbConstraints] 부분 유니크 인덱스 생성 실패:', err);
});

// 2026-09-30(M-15): 최후 방어선 — createRouter()가 라우트 예외를 잡아주지만, 스케줄러 등 라우트 밖에서
// 새는 rejection이 프로세스를 종료시키지 않도록 기록만 하고 계속 동작한다.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});

// 2026-10-01(A안): 다우오피스 자동 동기화 배제 — 스케줄러를 아예 띄우지 않는다(기본 꺼짐).
// 정책값(DAUOFFICE_AUTO_SYNC_ENABLED / DAUOFFICE_LEAVE_SCRAPE_ENABLED)은 그대로 두고, 그 앞단에서 막는다.
// 되돌리려면 .env.prod에 DAUOFFICE_SCHEDULERS_ENABLED=true 를 넣고 재배포한다.
if (dauofficeSchedulersEnabled()) {
  // eslint-disable-next-line no-console
  console.log('[Dauoffice] 스케줄러 활성화됨(DAUOFFICE_SCHEDULERS_ENABLED=true) — 정책값이 켜져 있으면 자동 동기화가 돕니다.');
  startDauofficeScheduler();
  startLeaveScrapeScheduler();
} else {
  // eslint-disable-next-line no-console
  console.log('[Dauoffice] 스케줄러 비활성(DAUOFFICE_SCHEDULERS_ENABLED 미설정) — 자동 동기화·휴가 스크래핑을 시작하지 않습니다.');
}
startClockInReminderScheduler();
startMismatchCoordPurgeScheduler();
