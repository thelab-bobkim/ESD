import { distanceMeters } from './geolocation';

/**
 * 2026-10-13: "본사에서 원격으로 작업했는데 작업위치를 '현장'으로 골라" 위치 불일치로 잡히는 경우(예: 본사에서 대전 건을
 * 야간작업으로 원격 수행)를 앱이 먼저 알아채 정중하게 되묻기 위한 순수 함수들이다.
 * 지금 위치가 본사 반경 안이고, 현장(ONSITE)으로 등록하려는 고객사 위치와 맞지 않아 막혔을 때만 제안한다.
 */
export const REMOTE_OFFER_STATUSES = new Set(['CLIENT_WORK', 'CLIENT_MEETING', 'NIGHT_WORK', 'WEEKEND_WORK']);
/** 서버의 위치 대조 반경과 같은 값을 쓴다. */
export const REMOTE_OFFER_HQ_RADIUS_METERS = 1000;

export function shouldOfferRemote(p: {
  status: string;
  siteType: unknown;
  loc: { lat: number; lng: number } | undefined;
  hq: { lat: number; lng: number } | null;
  radiusMeters?: number;
}): { offer: boolean; hqDistanceMeters: number | null } {
  if (!REMOTE_OFFER_STATUSES.has(p.status) || p.siteType !== 'ONSITE' || !p.loc || !p.hq) {
    return { offer: false, hqDistanceMeters: null };
  }
  const d = Math.round(distanceMeters(p.loc.lat, p.loc.lng, p.hq.lat, p.hq.lng));
  return { offer: d <= (p.radiusMeters ?? REMOTE_OFFER_HQ_RADIUS_METERS), hqDistanceMeters: d };
}

/** 위치 불일치로 막힌 등록 요청(body)을 "원격 작업"으로 바꾼다 — 작업위치와 note의 표기만 고친다. */
export function applyRemoteToBody(body: Record<string, unknown>): void {
  body.siteType = 'REMOTE';
  if (typeof body.note === 'string') body.note = body.note.split('작업위치: 현장').join('작업위치: 원격');
}

/**
 * 2026-10-13: 고객사에 상주하는 직원(배정 고객사가 있는 직원)이 상주지에서 "본사근무"를 눌러 위치 불일치로 막힌 경우 —
 * 본사근무가 아니라 "고객사상주"가 맞을 가능성이 높아 먼저 정중하게 되묻기 위한 순수 함수.
 * 지금 위치가 배정 고객사(상주지) 반경 안일 때만 제안한다.
 */
export const RESIDENT_OFFER_RADIUS_METERS = 1000;

export function shouldOfferResident(p: {
  status: string;
  loc: { lat: number; lng: number } | undefined;
  assigned: { latitude: number; longitude: number } | null;
  radiusMeters?: number;
}): { offer: boolean; distanceMeters: number | null } {
  if (p.status !== 'HQ_WORKING' || !p.loc || !p.assigned) return { offer: false, distanceMeters: null };
  const d = Math.round(distanceMeters(p.loc.lat, p.loc.lng, p.assigned.latitude, p.assigned.longitude));
  return { offer: d <= (p.radiusMeters ?? RESIDENT_OFFER_RADIUS_METERS), distanceMeters: d };
}
