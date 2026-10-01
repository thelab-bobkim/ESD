/**
 * 2026-10-01(A안): 다우오피스 자동 동기화 배제.
 *
 * 두 스케줄러(dauoffice-scheduler, leave-scrape-scheduler)는 이미 정책값으로 한 번 더 꺼져 있지만
 * (DAUOFFICE_AUTO_SYNC_ENABLED / DAUOFFICE_LEAVE_SCRAPE_ENABLED, 둘 다 기본 false), 그 정책값이 켜지면
 * 곧바로 외부 시스템(다우오피스)을 호출한다. "이제 다우오피스 동기화는 배제한다"는 결정에 따라
 * 스케줄러 자체를 부팅 시점에 띄우지 않는다 — 정책값과 무관하게, 명시적으로 켤 때만 동작한다.
 *
 * 되돌리기: .env.prod에 DAUOFFICE_SCHEDULERS_ENABLED=true 를 넣고 재배포하면 원래 동작으로 돌아온다
 * (정책값 DAUOFFICE_AUTO_SYNC_ENABLED 등도 함께 켜야 실제로 돈다 — 이중 잠금).
 * 수동 트리거(POST /dauoffice/sync/employees 등)와 관리자 화면 버튼은 그대로 남겨둔다(A안의 범위).
 */
export function dauofficeSchedulersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DAUOFFICE_SCHEDULERS_ENABLED === 'true';
}
