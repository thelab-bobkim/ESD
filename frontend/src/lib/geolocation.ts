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

/** 백엔드의 LocationCaptureStatus(Prisma enum)와 값을 맞춘다. */
export type LocationCaptureStatus = 'OK' | 'NO_CONSENT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | 'GEOCODE_FAILED';

export interface LocationCaptureResult {
  status: LocationCaptureStatus;
  address: string | null;
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
): Promise<{ status: LocationCaptureStatus; coords: { lat: number; lng: number } | null }> {
  if (!locationConsentGiven) return { status: 'NO_CONSENT', coords: null };
  if (typeof navigator === 'undefined' || !navigator.geolocation) return { status: 'UNSUPPORTED', coords: null };

  const result = await new Promise<{ lat: number; lng: number } | { errorCode: number } | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => resolve({ errorCode: err.code }),
      { timeout: 8000, maximumAge: 60000 }
    );
  });

  if (!result) return { status: 'UNSUPPORTED', coords: null };
  if ('errorCode' in result) {
    return { status: result.errorCode === 3 ? 'TIMEOUT' : result.errorCode === 1 ? 'PERMISSION_DENIED' : 'UNSUPPORTED', coords: null };
  }
  return { status: 'OK', coords: result };
}

/**
 * 퇴근 확인 모달 전용 — getCurrentLocation()과 달리 "왜" 위치를 못 가져왔는지까지 구분해서 돌려준다.
 * locationConsentGiven이 false면 애초에 브라우저에 물어보지도 않고 NO_CONSENT로 즉시 반환한다
 * (동의 안 한 사용자에게 갑자기 권한 팝업을 띄우지 않기 위함 — 동의 흐름은 LocationConsentModal에서만).
 */
export async function getCurrentLocationDetailed(locationConsentGiven: boolean): Promise<LocationCaptureResult> {
  if (!locationConsentGiven) return { status: 'NO_CONSENT', address: null };
  if (typeof navigator === 'undefined' || !navigator.geolocation) return { status: 'UNSUPPORTED', address: null };

  const coords = await new Promise<{ lat: number; lng: number } | { errorCode: number } | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => resolve({ errorCode: err.code }),
      { timeout: 8000, maximumAge: 60000 }
    );
  });

  if (!coords) return { status: 'UNSUPPORTED', address: null };
  if ('errorCode' in coords) {
    // GeolocationPositionError: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
    return { status: coords.errorCode === 3 ? 'TIMEOUT' : coords.errorCode === 1 ? 'PERMISSION_DENIED' : 'UNSUPPORTED', address: null };
  }

  const address = await reverseGeocode(coords.lat, coords.lng);
  if (!address) return { status: 'GEOCODE_FAILED', address: null };
  return { status: 'OK', address };
}
