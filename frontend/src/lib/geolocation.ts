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
      { timeout: 8000, maximumAge: 60000 }
    );
  });
}
