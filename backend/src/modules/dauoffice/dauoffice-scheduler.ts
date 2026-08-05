import { getPolicyBoolean, getPolicyNumber } from '../../common/policy-engine/policy-engine';
import { syncEmployeesFromDauoffice } from './sync-employees';
import { syncAttendanceFromDauoffice } from './sync-attendance';

/**
 * 다우오피스 자동 동기화 스케줄러.
 *
 * 안전을 위해 기본값은 항상 꺼짐(DAUOFFICE_AUTO_SYNC_ENABLED=false)이다.
 * 관리자가 정책 설정 화면(또는 API)에서 값을 true로 바꿔야만 자동 동기화가 시작된다.
 * 실제 운영 데이터에 영향을 주는 기능이므로, 처음에는 반드시 수동 트리거(POST /dauoffice/sync/*)로
 * 결과를 검증한 뒤 자동 동기화를 켜는 것을 권장한다 (DAUOFFICE_INTEGRATION.md 참조).
 */
export function startDauofficeScheduler() {
  const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10분마다 "지금 돌려야 하는지" 확인

  setInterval(async () => {
    try {
      const enabled = await getPolicyBoolean('DAUOFFICE_AUTO_SYNC_ENABLED', false);
      if (!enabled) return;

      const intervalHours = await getPolicyNumber('DAUOFFICE_SYNC_INTERVAL_HOURS', 6);
      const now = new Date();
      // 매 intervalHours마다 정시 근처에만 실행 (간단한 MVP 스케줄링 — 정밀한 cron은 아님)
      if (now.getHours() % Math.max(1, intervalHours) !== 0 || now.getMinutes() >= 10) return;

      // eslint-disable-next-line no-console
      console.log('[DauofficeScheduler] 자동 동기화 시작');
      await syncEmployeesFromDauoffice(null);
      await syncAttendanceFromDauoffice(now.getFullYear(), now.getMonth() + 1, null);
      // eslint-disable-next-line no-console
      console.log('[DauofficeScheduler] 자동 동기화 완료');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[DauofficeScheduler] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
