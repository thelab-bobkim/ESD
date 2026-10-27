/**
 * 2026-10-15: PC(노트북·데스크톱)로 접속한 직원 안내.
 * PC에는 GPS가 없어 Wi-Fi·인터넷 주소로 위치를 추정하기 때문에 오차가 크거나 위치를 못 구할 수 있다
 * (실제 신고: PC로 출근 등록이 여러 번 안 되다가 겨우 됨). 그래서 PC 접속자에게만
 *  - 화면 위쪽에 "PC는 위치가 부정확할 수 있어요 / 안 되면 휴대폰으로" 안내 카드를 보여주고,
 *  - 위치 때문에 등록이 막혔을 때는 오류 문구 뒤에 PC용 안내를 덧붙인다.
 */

export const PC_GUIDE_DISMISS_KEY = 'pcLocationGuideDismissedAt';
export const PC_GUIDE_HIDE_DAYS = 7;

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Mobi|Windows Phone|webOS|BlackBerry/i;

/** 휴대폰·태블릿이 아니면 PC로 본다. (아이패드 사파리는 Mac으로 위장하므로 터치 지점 수로 걸러낸다.) */
export function isDesktopBrowser(p: { userAgent?: string; uaDataMobile?: boolean; maxTouchPoints?: number }): boolean {
  if (p.uaDataMobile === true) return false;
  const ua = p.userAgent ?? '';
  if (!ua) return false;
  if (MOBILE_UA.test(ua)) return false;
  if (/Macintosh/i.test(ua) && (p.maxTouchPoints ?? 0) > 1) return false;
  return true;
}

/** 브라우저 환경에서 현재 기기가 PC인지 판단한다(서버 렌더링 중에는 false). */
export function detectDesktopBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return isDesktopBrowser({ userAgent: nav.userAgent, uaDataMobile: nav.userAgentData?.mobile, maxTouchPoints: nav.maxTouchPoints });
}

/** 안내 카드를 숨긴 뒤 PC_GUIDE_HIDE_DAYS 일이 지나면 다시 보여준다. 숨긴 기록이 없거나 시계가 어긋나 있어도 보여준다. */
export function shouldShowPcGuide(dismissedAtMs: number | null | undefined, nowMs: number): boolean {
  if (typeof dismissedAtMs !== 'number' || !Number.isFinite(dismissedAtMs)) return true;
  if (dismissedAtMs > nowMs) return true;
  return nowMs - dismissedAtMs >= PC_GUIDE_HIDE_DAYS * 24 * 60 * 60 * 1000;
}

export function readPcGuideDismissedAt(): number | null {
  try {
    const raw = localStorage.getItem(PC_GUIDE_DISMISS_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writePcGuideDismissedAt(nowMs: number): void {
  try {
    localStorage.setItem(PC_GUIDE_DISMISS_KEY, String(nowMs));
  } catch {
    /* 저장이 막힌 브라우저에서는 이번 화면에서만 숨긴다. */
  }
}

export const PC_GUIDE_SUMMARY =
  'PC에는 GPS가 없어서 Wi-Fi로 위치를 추정해요. 그래서 위치가 부정확하거나 확인이 늦어질 수 있어요. 위치 때문에 등록이 안 되면 휴대폰으로 등록해 주세요.';

export const PC_GUIDE_STEPS: { title: string; detail: string }[] = [
  { title: 'Wi-Fi를 켜 두세요', detail: '랜선만 쓰면 위치 추정에 쓸 정보가 없어 오차가 수백 m~수 km까지 날 수 있어요. 노트북은 랜선이 꽂혀 있어도 Wi-Fi를 켜 두세요.' },
  { title: 'VPN은 꺼 주세요', detail: 'VPN을 켜면 위치가 다른 곳으로 잡힐 수 있어요.' },
  { title: 'Windows 위치 서비스를 확인하세요', detail: '설정 → 개인 정보(Windows 11은 "개인 정보 및 보안") → 위치에서 "위치 서비스"와 "데스크톱 앱이 위치에 액세스하도록 허용"을 켜 주세요.' },
  { title: 'Chrome에서 이 사이트의 위치를 허용하세요', detail: '주소창 왼쪽 자물쇠 아이콘 → 사이트 설정 → 위치를 "허용"으로 바꿔 주세요.' },
  { title: '"출근" 버튼 대신 근무 형태 버튼을 누르세요', detail: '본사근무 등 실제 근무 형태 버튼을 누르면 그 순간이 출근 시각이 돼요. 누른 뒤 나오는 "밀어서 확정" 막대는 클릭이 아니라 마우스를 누른 채 오른쪽 끝까지 끌어야 해요.' },
  { title: '위치 확인에는 최대 20초 걸려요', detail: '측정하는 동안 다시 누르지 말고 기다려 주세요.' },
  { title: '그래도 안 되면 휴대폰으로 등록하세요', detail: '휴대폰은 GPS를 쓰기 때문에 PC보다 위치가 훨씬 정확해요.' },
];

/** PC에서 위치 문제로 등록이 막혔을 때 오류 문구 뒤에 덧붙이는 안내. */
export const PC_FAILURE_HINT =
  '💻 PC는 위치가 부정확할 수 있어요. Wi-Fi를 켜고 VPN을 끈 뒤 다시 시도하고, 그래도 안 되면 휴대폰으로 등록해 주세요.';

export const PC_LOCATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'GPS_ACCURACY_LOW',
  'LOCATION_REQUIRED',
  'LOCATION_REQUIRED_STRICT',
  'LOCATION_REQUIRED_FOR_WORK_START',
  'LOCATION_REQUIRED_FOR_CLOCKIN',
  'AWAY_FROM_HQ',
  'LOCATION_MISMATCH_BLOCKED',
  'LOCATION_MISMATCH_TOO_FAR',
  'LOCATION_CORRECTION_NOT_AT_TARGET',
]);

export function appendPcLocationHint(message: string, code: string | undefined, isDesktop: boolean): string {
  if (!isDesktop || !code || !PC_LOCATION_ERROR_CODES.has(code)) return message;
  if (message.includes(PC_FAILURE_HINT)) return message;
  return `${message} ${PC_FAILURE_HINT}`;
}
