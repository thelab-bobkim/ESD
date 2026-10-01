import { getPolicyBoolean, getPolicyNumber } from '../../common/policy-engine/policy-engine';
import { syncEmployeesFromDauoffice } from './sync-employees';

/**
 * 다우오피스 자동 동기화 스케줄러.
 *
 * 안전을 위해 기본값은 항상 꺼짐(DAUOFFICE_AUTO_SYNC_ENABLED=false)이다.
 * 관리자가 정책 설정 화면(또는 API)에서 값을 true로 바꿔야만 자동 동기화가 시작된다.
 * 실제 운영 데이터에 영향을 주는 기능이므로, 처음에는 반드시 수동 트리거(POST /dauoffice/sync/*)로
 * 결과를 검증한 뒤 자동 동기화를 켜는 것을 권장한다 (DAUOFFICE_INTEGRATION.md 참조).
 *
 * 2026-09-02: 근태(출퇴근) 동기화는 dauoffice.routes.ts에서 이미 수동 트리거 버튼/엔드포인트를
 * 없앴었지만(2026-09-01), 이 자동 스케줄러에서는 여전히 syncAttendanceFromDauoffice()를 호출하고
 * 있어서 "다우오피스 출근기록 기반 자동 추정" 상태가 계속 생성되고 있었다(관리자 상황판에
 * "(자동추정)" 배지로 나타남). 요청에 따라 출퇴근 기록은 이제 전적으로 TSB 앱 안에서 직원이
 * 직접 등록한 것만 인정하기로 해서, 이 자동 동기화 호출도 완전히 제거한다. 조직도(직원) 동기화는
 * 부서 변경 등을 반영해야 하므로 그대로 유지한다. (구현은 sync-attendance.ts에 남아있지만
 * 더 이상 아무 곳에서도 호출하지 않는다.)
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
      // 2026-09-30 수정(L-8): getHours()는 컨테이너 로컬 시각(UTC)이라 "정시"가 KST와 9시간 어긋났다
      // (purge 스케줄러는 a10b7c8에서 같은 문제를 고쳤는데 이 파일은 빠져 있었다). KST 기준으로 판정한다.
      const kstHour = (now.getUTCHours() + 9) % 24;
      if (kstHour % Math.max(1, intervalHours) !== 0 || now.getUTCMinutes() >= 10) return;

      // eslint-disable-next-line no-console
      console.log('[DauofficeScheduler] 자동 동기화 시작(조직도만)');
      await syncEmployeesFromDauoffice(null);
      // eslint-disable-next-line no-console
      console.log('[DauofficeScheduler] 자동 동기화 완료');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[DauofficeScheduler] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
