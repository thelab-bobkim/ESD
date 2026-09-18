import { getPolicyBoolean } from '../../common/policy-engine/policy-engine';
import { scrapeCompanyLeaveStatus } from './leave-scraper';

const LEAVE_SCRAPE_HOURS_KST = [10, 13]; // 오전 10시, 오후 1시(13시) — 관리자 요청.

/**
 * 2026-09-18: 다우오피스 "전사 휴가현황" 스크래핑 스케줄러. dauoffice-scheduler.ts와 같은 패턴
 * (정밀한 cron 대신 10분마다 "지금 돌려야 하는지" 확인)을 따른다.
 *
 * 기본값은 항상 꺼짐(DAUOFFICE_LEAVE_SCRAPE_ENABLED=false) — leave-scraper.ts의 로그인 셀렉터가
 * 실제 다우오피스 로그인 페이지 구조를 보지 못한 채 작성한 추정치라, 관리자가
 * POST /dauoffice/leave/scrape?dryRun=true (dauoffice.routes.ts)로 먼저 결과를 확인하고 정책을
 * 켜는 것을 권장한다.
 */
export function startLeaveScrapeScheduler() {
  const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10분마다 확인
  // 'YYYY-MM-DD' -> 그날 이미 실행한 시각(10, 13) 집합. 같은 슬롯을 하루에 두 번 돌리지 않기 위함
  // (10분 폴링 창 안에서 여러 번 걸릴 수 있음). 프로세스 재시작 시 초기화되는 건 감수한다(MVP).
  const ranSlotsByDate = new Map<string, Set<number>>();

  setInterval(async () => {
    try {
      const enabled = await getPolicyBoolean('DAUOFFICE_LEAVE_SCRAPE_ENABLED', false);
      if (!enabled) return;

      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const hour = kst.getUTCHours();
      const minute = kst.getUTCMinutes();
      if (!LEAVE_SCRAPE_HOURS_KST.includes(hour) || minute >= 10) return;

      const dateKey = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
      const ranSlots = ranSlotsByDate.get(dateKey) ?? new Set<number>();
      if (ranSlots.has(hour)) return;
      ranSlots.add(hour);
      ranSlotsByDate.set(dateKey, ranSlots);
      // 지난 날짜 기록은 더 필요 없으니 정리(메모리 누수 방지).
      for (const key of ranSlotsByDate.keys()) {
        if (key !== dateKey) ranSlotsByDate.delete(key);
      }

      // eslint-disable-next-line no-console
      console.log(`[LeaveScrapeScheduler] ${hour}시 휴가현황 스크래핑 시작`);
      const result = await scrapeCompanyLeaveStatus({ dryRun: false });
      // eslint-disable-next-line no-console
      console.log(
        `[LeaveScrapeScheduler] 완료 — 스크랩 ${result.scrapedRowCount}행, 저장 ${result.savedCount}건, 매칭 실패 ${result.unmatched.length}건`
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[LeaveScrapeScheduler] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}
