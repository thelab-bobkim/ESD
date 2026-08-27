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
