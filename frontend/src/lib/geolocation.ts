/** 두 좌표 사이 거리(미터). 본사 복귀 감지에 쓴다(서버로 전송하지 않고 브라우저 안에서만 계산). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
declare global {
  interface Window {
    kakao: any;
  }
}

function loadKakaoScriptOnce(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.kakao?.maps?.services) {
      resolve();
      return;
    }
    const key = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;
    if (!key) {
      reject(new Error('카카오맵 키 없음'));
      return;
    }
    const existing = document.querySelector('script[data-kakao-sdk]');
    if (existing) {
      existing.addEventListener('load', () => window.kakao.maps.load(() => resolve()));
      return;
    }
    const script = document.createElement('script');
    script.dataset.kakaoSdk = 'true';
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false&libraries=services`;
    script.onload = () => window.kakao.maps.load(() => resolve());
    script.onerror = () => reject(new Error('카카오맵 로드 실패'));
    document.head.appendChild(script);
  });
}

/**
 * 좌표를 사람이 읽을 수 있는 주소 텍스트로 변환한다. 실패하면 null. 이 함수는 좌표 자체를
 * 어디에도 저장하지 않고, 변환된 "주소 문자열"만 호출한 쪽에 돌려준다(퇴근 위치 표시용).
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    await loadKakaoScriptOnce();
    return await new Promise((resolve) => {
      const geocoder = new window.kakao.maps.services.Geocoder();
      geocoder.coord2Address(lng, lat, (result: any[], status: string) => {
        if (status === window.kakao.maps.services.Status.OK && result[0]) {
          resolve(result[0].road_address?.address_name || result[0].address?.address_name || null);
        } else {
          resolve(null);
        }
      });
    });
  } catch {
    return null;
  }
}

/**
 * 2026-09-02: enableHighAccuracy를 지정하지 않으면(=false가 기본값) 브라우저가 GPS 대신
 * WiFi/IP 기반의 부정확한 위치를 반환할 수 있다(실내/데스크탑에서 특히 심함 — 실제로 본사
 * 건물 안에 있는데도 수백m~수km 떨어진 것으로 잡히는 사례가 있었다). true로 지정해 가능한 한
 * 실제 GPS 수신을 요청한다. maximumAge도 0으로 낮춰 캐시된(어긋났을 수 있는) 좌표를 재사용하지
 * 않게 하고, GPS 정밀 수신에 시간이 더 걸릴 수 있어 timeout도 늘렸다.
 */
const GEOLOCATION_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

/**
 * 2026-09 GPS 정확도 개선: 오차범위(accuracy, 미터)가 이 값보다 크면 "정확도가 낮다"고 보고
 * 한 번 더 측정을 시도한다. 실내/건물 안에서는 처음 응답이 WiFi/기지국 기반의 부정확한 값으로
 * 오는 경우가 있는데, 잠깐 사이에 기기가 GPS 위성 신호를 더 잡아 두 번째 시도에서 정확도가
 * 크게 개선되는 사례가 실제로 있다(사용자 보고: 출근 시 "본사에서 약 835m", 퇴근 시 "오차범위
 * 약 2km"). 100m를 기준으로 삼은 이유: 본사 위치대조 반경(LOCATION_MATCH_RADIUS_METERS)이
 * 500m라, 오차범위가 그 절반 이하는 되어야 "본사 안인지 아닌지"를 신뢰성 있게 가를 수 있다.
 */
const LOW_ACCURACY_RETRY_THRESHOLD_METERS = 100;
// 재시도 사이의 대기시간 — 기기가 새 위성신호를 잡을 최소한의 시간을 준다.
const ACCURACY_RETRY_DELAY_MS = 1500;

function getPositionOnce(): Promise<GeolocationPosition | { errorCode: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => resolve({ errorCode: err.code }),
      GEOLOCATION_OPTIONS
    );
  });
}

/**
 * 위치를 가져오되, 오차범위가 크면(LOW_ACCURACY_RETRY_THRESHOLD_METERS 초과) 한 번 더 시도해서
 * 더 정확한 값이 나오면 그걸 쓴다. 재시도는 최대 한 번만 하고(안 그러면 사용자가 계속 기다려야
 * 함), 두 번째 시도가 오히려 더 부정확하면 첫 번째 값을 그대로 쓴다. 첫 시도 자체가 실패하면
 * errorCode를 그대로 반환한다.
 */
async function getPositionWithAccuracyRetry(): Promise<{ pos: GeolocationPosition | null; errorCode: number | null }> {
  const first = await getPositionOnce();
  if (!first) return { pos: null, errorCode: null };
  if ('errorCode' in first) return { pos: null, errorCode: first.errorCode };
  if (first.coords.accuracy <= LOW_ACCURACY_RETRY_THRESHOLD_METERS) {
    return { pos: first, errorCode: null };
  }

  await new Promise((resolve) => setTimeout(resolve, ACCURACY_RETRY_DELAY_MS));
  const second = await getPositionOnce();
  if (!second || 'errorCode' in second) return { pos: first, errorCode: null };
  return { pos: second.coords.accuracy < first.coords.accuracy ? second : first, errorCode: null };
}

/** 오차범위(미터)가 기준치보다 커서 "낮은 정확도" 경고를 보여줘야 하는지 판단한다. */
export function isLowAccuracy(accuracyMeters: number | null | undefined): accuracyMeters is number {
  return typeof accuracyMeters === 'number' && accuracyMeters > LOW_ACCURACY_RETRY_THRESHOLD_METERS;
}

/** 낮은 정확도일 때 사용자에게 보여줄 안내 문구. */
export function accuracyWarningLabel(accuracyMeters: number): string {
  return `GPS 정확도가 낮아요(오차범위 약 ${Math.round(accuracyMeters)}m). 실외로 나가거나 창가 쪽으로 이동한 뒤 다시 시도하면 정확도가 개선될 수 있어요.`;
}

// 2026-09 이상치(순간이동) 필터링: 스마트폰이 갑자기 엉뚱한 기지국 위치를 잡아 좌표가 튀는 경우를
// 걸러내기 위해, 직전에 정상 확인된 위치·시각을 기억해뒀다가 다음 위치와 비교한다. 서버에는 좌표를
// 저장하지 않는다는 이 앱의 원칙을 지키기 위해, 이 값은 오직 이 브라우저(localStorage)에만 남기고
// 서버로는 전송하지 않는다.
const LAST_POSITION_STORAGE_KEY = 'dsti_last_known_position_v1';
// 시속 200km 기준(국내 고속도로 최고속도를 넉넉히 웃도는 값) — 이보다 빠르면 실제 이동이 아니라
// GPS/기지국이 순간적으로 엉뚱한 좌표를 잡은 것으로 본다("이동 속도 검증", 2026-09 요청).
const JUMP_SPEED_MPS = 200 / 3.6;
// 직전 위치가 이보다 오래됐으면(오랜만에 앱을 다시 여는 경우 등) 비교 자체가 의미 없으므로
// 이상치 판정 없이 그냥 새 위치로 갱신만 한다 — 장시간에 걸친 정상적인 이동까지 막지 않기 위함.
const LAST_POSITION_MAX_AGE_MS = 20 * 60 * 1000;

interface StoredPosition { lat: number; lng: number; at: number; }

function readLastPosition(): StoredPosition | null {
  try {
    const raw = localStorage.getItem(LAST_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.lat === 'number' && typeof parsed?.lng === 'number' && typeof parsed?.at === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeLastPosition(pos: StoredPosition) {
  try {
    localStorage.setItem(LAST_POSITION_STORAGE_KEY, JSON.stringify(pos));
  } catch {
    // 저장 실패(프라이빗 모드 등)해도 기능에 지장은 없다 — 이번 한 번만 이상치 검증을 건너뛴다.
  }
}

/**
 * 방금 받은 좌표가 직전에 저장해둔 좌표 대비 "사람이 이동할 수 없는 속도"로 튀었는지 확인한다.
 * 이상치가 아니면(또는 비교할 이전 값이 없거나 너무 오래됐으면) 이번 좌표를 새 기준으로 저장하고
 * false를 반환한다. 이상치로 판단되면 기준값은 그대로 두고(오염된 값으로 덮어쓰지 않음) true를
 * 반환한다 — 호출하는 쪽에서 등록을 막고 재측정을 유도한다.
 */
function checkAndUpdateJumpDetection(lat: number, lng: number): boolean {
  const now = Date.now();
  const last = readLastPosition();
  let jumpDetected = false;
  if (last) {
    const elapsedMs = now - last.at;
    if (elapsedMs > 0 && elapsedMs <= LAST_POSITION_MAX_AGE_MS) {
      const distance = distanceMeters(last.lat, last.lng, lat, lng);
      const speedMps = distance / (elapsedMs / 1000);
      if (speedMps > JUMP_SPEED_MPS) jumpDetected = true;
    }
  }
  if (!jumpDetected) {
    writeLastPosition({ lat, lng, at: now });
  }
  return jumpDetected;
}

/** 이상치(순간이동) 감지 시 사용자에게 보여줄 안내 문구. */
export const LOCATION_JUMP_WARNING =
  '⚠️ 위치가 순간적으로 비정상적인 거리만큼 이동한 것으로 감지됐어요(GPS/기지국 오류 가능성). 제자리에서 잠시 후 다시 시도해주세요.';

/**
 * 현재 위치를 가져온다. 실패하거나 권한이 없으면 null을 반환한다(위치확인은 선택적 기능이라
 * 실패해도 상태등록 자체는 막지 않는다).
 */
export function getCurrentLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      GEOLOCATION_OPTIONS
    );
  });
}

/** 백엔드의 LocationCaptureStatus(Prisma enum)와 값을 맞춘다. */
export type LocationCaptureStatus = 'OK' | 'NO_CONSENT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | 'GEOCODE_FAILED';

export interface LocationCaptureResult {
  status: LocationCaptureStatus;
  address: string | null;
  accuracyMeters: number | null;
  jumpDetected: boolean;
}

const LOCATION_FAILURE_LABEL: Record<Exclude<LocationCaptureStatus, 'OK'>, string> = {
  NO_CONSENT: '위치정보 수집에 동의하지 않으셨어요',
  PERMISSION_DENIED: '브라우저에서 위치 권한이 거부되어 있어요',
  TIMEOUT: '위치 확인이 시간 내에 응답하지 않았어요',
  UNSUPPORTED: '이 기기/브라우저는 위치 확인을 지원하지 않아요',
  GEOCODE_FAILED: '좌표는 확인했지만 주소로 변환하지 못했어요',
};

export function locationFailureLabel(status: Exclude<LocationCaptureStatus, 'OK'>): string {
  return LOCATION_FAILURE_LABEL[status];
}

/**
 * 고객사미팅/고객사작업 등록 전용 — 좌표(서버에서 등록된 고객사와 대조 후 즉시 폐기)와 함께
 * "왜" 위치를 못 가져왔는지도 같이 돌려준다(서버의 "GPS 실패는 하루 1회만 봐준다" 판단에 필요).
 * getCurrentLocationDetailed()와 달리 주소로 역지오코딩하지 않는다(좌표 대조만 하면 되므로).
 */
export async function getCurrentLocationWithStatus(
  locationConsentGiven: boolean
): Promise<{ status: LocationCaptureStatus; coords: { lat: number; lng: number } | null; accuracyMeters: number | null; jumpDetected: boolean }> {
  if (!locationConsentGiven) return { status: 'NO_CONSENT', coords: null, accuracyMeters: null, jumpDetected: false };
  if (typeof navigator === 'undefined' || !navigator.geolocation) return { status: 'UNSUPPORTED', coords: null, accuracyMeters: null, jumpDetected: false };

  const { pos, errorCode } = await getPositionWithAccuracyRetry();
  if (!pos) {
    if (errorCode === null) return { status: 'UNSUPPORTED', coords: null, accuracyMeters: null, jumpDetected: false };
    return {
      status: errorCode === 3 ? 'TIMEOUT' : errorCode === 1 ? 'PERMISSION_DENIED' : 'UNSUPPORTED',
      coords: null,
      accuracyMeters: null,
      jumpDetected: false,
    };
  }
  const jumpDetected = checkAndUpdateJumpDetection(pos.coords.latitude, pos.coords.longitude);
  return {
    status: 'OK',
    // 이상치로 판단된 좌표는 대조에 쓰지 말라는 신호로 coords를 비워서 돌려준다 — 호출하는 쪽은
    // jumpDetected를 보고 등록을 막고 재측정을 유도한다.
    coords: jumpDetected ? null : { lat: pos.coords.latitude, lng: pos.coords.longitude },
    accuracyMeters: pos.coords.accuracy,
    jumpDetected,
  };
}

/**
 * 퇴근 확인 모달 전용 — getCurrentLocation()과 달리 "왜" 위치를 못 가져왔는지까지 구분해서 돌려준다.
 * locationConsentGiven이 false면 애초에 브라우저에 물어보지도 않고 NO_CONSENT로 즉시 반환한다
 * (동의 안 한 사용자에게 갑자기 권한 팝업을 띄우지 않기 위함 — 동의 흐름은 LocationConsentModal에서만).
 */
export async function getCurrentLocationDetailed(locationConsentGiven: boolean): Promise<LocationCaptureResult> {
  if (!locationConsentGiven) return { status: 'NO_CONSENT', address: null, accuracyMeters: null, jumpDetected: false };
  if (typeof navigator === 'undefined' || !navigator.geolocation) return { status: 'UNSUPPORTED', address: null, accuracyMeters: null, jumpDetected: false };

  const { pos, errorCode } = await getPositionWithAccuracyRetry();
  if (!pos) {
    if (errorCode === null) return { status: 'UNSUPPORTED', address: null, accuracyMeters: null, jumpDetected: false };
    // GeolocationPositionError: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
    return {
      status: errorCode === 3 ? 'TIMEOUT' : errorCode === 1 ? 'PERMISSION_DENIED' : 'UNSUPPORTED',
      address: null,
      accuracyMeters: null,
      jumpDetected: false,
    };
  }

  const jumpDetected = checkAndUpdateJumpDetection(pos.coords.latitude, pos.coords.longitude);
  const accuracyMeters = pos.coords.accuracy;
  if (jumpDetected) {
    // 이상치로 판단되면 주소 변환(추가 API 호출)까지 갈 필요 없이 바로 알린다 — 호출하는 쪽이
    // 퇴근 확정을 막고 재측정 버튼을 보여준다.
    return { status: 'OK', address: null, accuracyMeters, jumpDetected: true };
  }
  const address = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
  if (!address) return { status: 'GEOCODE_FAILED', address: null, accuracyMeters, jumpDetected: false };
  return { status: 'OK', address, accuracyMeters, jumpDetected: false };
}
