/**
 * 두 좌표 사이 거리(미터)를 계산한다(Haversine 공식).
 * 이 값을 계산하는 데만 좌표를 쓰고, 계산이 끝나면 좌표 자체는 어디에도 저장하지 않는다.
 */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // 지구 반지름(m)
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 이 거리(미터) 이내면 "해당 고객사 위치와 일치"로 판정한다. 도보로 오차 범위를 감안한 값
// (기존 300m는 너무 빡빡하다는 현장 피드백을 반영해 500m로 완화했으나, 500m 반경에서도
// 불일치로 뜨는 사례가 있어 2026-09-14 본사와 동일하게 1000m로 재조정).
const LOCATION_MATCH_RADIUS_METERS = 1000;

// 본사(HQ) 전용 반경 — 실사용 중 신한이노플렉스 사무실(고층 건물)에서 GPS가 최대 835m까지
// 빗나가는 사례가 실측되어(2026-09), 고객사 위치대조(스푸핑 방지 목적이 더 큰)와 분리해서
// 본사만 더 넉넉하게 잡는다. 건물명/도로명 주소 매칭(attendance.routes.ts의 isHqAddressMatch)과
// 사내망 IP 확인(isRequestFromOfficeNetwork)까지 함께 적용되므로, 반경을 넓혀도 "본사 여부"
// 판정의 다른 안전장치가 남아있다.
export const HQ_LOCATION_MATCH_RADIUS_METERS = 1000;

// 2026-09-16: GPS가 스스로 보고하는 오차범위(accuracy, 미터)만큼은 실제로 반경 안에 있어도 좌표가
// 밖으로 튈 수 있다는 뜻이므로, 그만큼은 반경에 더해 관대하게 봐준다("거리 - 오차범위 <= 반경"와
// 수학적으로 동일). 지금까지 반경 상수 자체를 300m→500m→1000m로 계속 늘려온 것도 사실 이 문제
// (정확도 나쁜 측정값 하나에 기준 전체를 맞춰온 것)였는데, 이제 측정마다의 실제 신뢰도를 보고
// 판단할 수 있다. 다만 오차범위 값 자체를 무한정 믿어줄 수는 없다 — 그러면 "오차범위가 50km"라고
// 우기는 조작된 값 하나로 어디서든 통과되어 버려 위치대조(특히 고객사 현장 사칭 방지 목적)가
// 무력화된다. 그래서 봐주는 양에 상한(MAX_ACCURACY_ALLOWANCE_METERS)을 둔다.
// 2026-09-30: attendance.routes.ts의 "위치 불일치 하드블록"(대표이사 결정 — 집 등 엉뚱한 곳에서
// 본사근무/고객사작업 등으로 출근을 확정하지 못하게 함)이, GPS 자체가 이 값보다 더 부정확하다고
// 스스로 보고한 경우(신한이노플렉스 등 고층건물 실내 최대 2.8km 오차 실측 사례)만 예외로 봐주기
// 위해 이 상수를 그대로 가져다 쓴다 — 그래서 모듈 내부 전용(private)에서 export로 바꿨다.
export const MAX_ACCURACY_ALLOWANCE_METERS = 1000;

/** accuracyMeters를 반경에 더해줄 "허용치"로 환산한다 — 상한을 넘는 값은 상한까지만 인정한다. */
function accuracyAllowanceMeters(accuracyMeters: number | null | undefined): number {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return 0;
  return Math.min(accuracyMeters, MAX_ACCURACY_ALLOWANCE_METERS);
}

/**
 * 직원이 보낸 좌표(location)와 등록된 고객사 좌표(client)를 비교해서 "일치 여부"와 "거리"만 반환한다.
 * - 고객사 좌표가 아직 등록 안 됐거나, 직원이 위치권한을 안 줬으면 null(확인 안 함)을 반환한다.
 * - 반환값에 원본 좌표는 포함하지 않는다 — 호출하는 쪽에서도 이 결과만 저장해야 한다.
 * - radiusMeters를 생략하면 기본(고객사용) 반경을 쓰고, 본사 확인 시에는 호출하는 쪽에서
 *   HQ_LOCATION_MATCH_RADIUS_METERS를 넘겨준다.
 * - accuracyMeters(그 순간 GPS가 보고한 오차범위)를 넘기면, 반경에 그만큼(상한 적용)을 더해
 *   판정한다 — 넘기지 않으면(기존 호출부와 동일) 이전과 완전히 같게 동작한다.
 */
export function checkLocationMatch(
  location: { lat: number; lng: number } | undefined,
  client: { latitude: number | null; longitude: number | null } | null | undefined,
  radiusMeters: number = LOCATION_MATCH_RADIUS_METERS,
  accuracyMeters?: number | null
): { locationMatch: boolean; locationDistanceMeters: number; effectiveRadiusMeters: number } | null {
  if (!location || !client || client.latitude == null || client.longitude == null) return null;
  const distance = haversineMeters(location.lat, location.lng, client.latitude, client.longitude);
  const effectiveRadiusMeters = radiusMeters + accuracyAllowanceMeters(accuracyMeters);
  return {
    locationMatch: distance <= effectiveRadiusMeters,
    locationDistanceMeters: Math.round(distance),
    effectiveRadiusMeters: Math.round(effectiveRadiusMeters),
  };
}

// 2026-09-18: "불일치 건만 좌표 저장" 정책 — 며칠 뒤 자동삭제할지(보관기간). 위치정보보호법의
// 목적 달성 시 즉시파기 원칙에 대응하기 위해 짧게(30일) 잡는다. 실제 삭제는
// modules/push/mismatch-coord-purge-scheduler.ts가 매일 수행한다.
export const MISMATCH_COORD_RETENTION_DAYS = 30;

// 2026-09-20: "감사인 전용 재택 위치 열람"(대표이사 승인)의 보관기간. 처음엔 위 불일치-좌표와
// 같은 이유(위치정보보호법 목적 달성 시 즉시파기 원칙)로 30일로 시작했으나, 2026-09-20
// 대표이사 요청으로 감사 업무 편의를 위해 6개월(180일)로 연장. 상수를 분리해둔 이유는 재택
// 위치는 "명백한 불일치 건"이 아니라 매번(정상 등록 포함) 남기는 값이라 성격이 달라서 —
// 나중에 감사 목적상 더 길게(또는 짧게) 가져가야 하면 이 값만 따로 조정할 수 있게 했다.
// ⚠️ 참고: 위치정보의 보호 및 이용 등에 관한 법률은 원칙적으로 "목적 달성 시 지체없이 파기"를
// 요구하므로, 30일보다 긴 보관 기간을 두려면 (1) 취업규칙/개인정보처리방침 등에 감사 목적의
// 보관기간을 명시하고 (2) 직원에게 사전 고지·동의를 받는 절차가 함께 갖춰져 있는지 법무 검토를
// 받는 것이 안전하다 — 이 상수 값만으로 법적 적정성이 보장되는 것은 아니다.
export const REMOTE_AUDIT_COORD_RETENTION_DAYS = 180;

/**
 * "불일치 건만 좌표 저장" 정책(2026-09-18, 사용자 승인) 전용 헬퍼.
 *
 * 근무 태만(위치 확인이 안 되는 허점을 이용한 무단 이탈 등) 방지를 위해, 딱 하나의 예외만
 * 둔다: checkLocationMatch()의 결과가 "명백히 불일치"(locationMatch === false)인 경우에만
 * 관리자가 직접 원본 좌표를 확인할 수 있도록 남긴다.
 * - locationMatch가 true(일치)이거나 결과 자체가 null(확인 불가/미동의)인 경우에는
 *   항상 null을 반환한다 — 호출하는 쪽이 실수로라도 불필요하게 좌표를 저장하지 않도록,
 *   판단 로직을 호출부마다 반복하지 않고 여기 한 곳에 모아둔다.
 * - 반환된 좌표는 반드시 mismatchLatitude/mismatchLongitude 컬럼에만 저장하고(보관기간 있음,
 *   관리자 전용 노출), 그 외에는 기존 원칙(원본 좌표 미저장)을 그대로 유지한다.
 */
export function buildMismatchCoords(
  location: { lat: number; lng: number } | undefined,
  locationResult: { locationMatch: boolean } | null | undefined
): { mismatchLatitude: number | null; mismatchLongitude: number | null } {
  if (!location || !locationResult || locationResult.locationMatch !== false) {
    return { mismatchLatitude: null, mismatchLongitude: null };
  }
  return { mismatchLatitude: location.lat, mismatchLongitude: location.lng };
}
