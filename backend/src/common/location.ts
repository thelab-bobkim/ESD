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

// 이 거리(미터) 이내면 "해당 고객사 위치와 일치"로 판정한다. 도보로 오차 범위를 감안한 값.
const LOCATION_MATCH_RADIUS_METERS = 300;

/**
 * 직원이 보낸 좌표(location)와 등록된 고객사 좌표(client)를 비교해서 "일치 여부"와 "거리"만 반환한다.
 * - 고객사 좌표가 아직 등록 안 됐거나, 직원이 위치권한을 안 줬으면 null(확인 안 함)을 반환한다.
 * - 반환값에 원본 좌표는 포함하지 않는다 — 호출하는 쪽에서도 이 결과만 저장해야 한다.
 */
export function checkLocationMatch(
  location: { lat: number; lng: number } | undefined,
  client: { latitude: number | null; longitude: number | null } | null | undefined
): { locationMatch: boolean; locationDistanceMeters: number } | null {
  if (!location || !client || client.latitude == null || client.longitude == null) return null;
  const distance = haversineMeters(location.lat, location.lng, client.latitude, client.longitude);
  return { locationMatch: distance <= LOCATION_MATCH_RADIUS_METERS, locationDistanceMeters: Math.round(distance) };
}
