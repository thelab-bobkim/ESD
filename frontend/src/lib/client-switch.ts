import { distanceMeters } from './geolocation';

/**
 * 2026-10-12: "코스콤 ↔ 코스콤 부산글로벌클라우드센터"처럼 본점/지점·공장이 따로 등록된 고객사에서, 작은 화면에서
 * 비슷한 이름을 잘못 눌러 위치가 어긋나는 경우를 앱이 먼저 알아채 정중하게 되묻기 위한 순수 함수들이다.
 */
export interface ClientWithLocation { name: string; latitude: number; longitude: number }
export interface NearbyClient { name: string; distanceMeters: number }

/** 서버의 고객사 위치 대조 반경(LOCATION_MATCH_RADIUS_METERS)과 같은 값을 쓴다. */
export const SWITCH_SUGGEST_RADIUS_METERS = 1000;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 지금 위치 근처(반경 안)에 등록된 "다른" 고객사를 가까운 순으로 돌려준다(선택한 고객사와 같은 이름은 제외). */
export function findNearbyOtherClients(
  loc: { lat: number; lng: number },
  selectedName: string,
  clients: ClientWithLocation[],
  radiusMeters = SWITCH_SUGGEST_RADIUS_METERS,
  limit = 3
): NearbyClient[] {
  return clients
    .filter((c) => !sameName(c.name, selectedName))
    .map((c) => ({ name: c.name, distanceMeters: Math.round(distanceMeters(loc.lat, loc.lng, c.latitude, c.longitude)) }))
    .filter((c) => c.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

/** 선택한 고객사의 등록 위치까지의 거리(같은 이름으로 정확히 등록된 경우만). 모르면 null. */
export function distanceToNamedClient(loc: { lat: number; lng: number }, name: string, clients: ClientWithLocation[]): number | null {
  const c = clients.find((x) => sameName(x.name, name));
  return c ? Math.round(distanceMeters(loc.lat, loc.lng, c.latitude, c.longitude)) : null;
}

/** 1000m 이상이면 km, 아니면 m로 읽기 쉽게 표시한다. */
export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `약 ${km >= 100 ? Math.round(km) : Math.round(km * 10) / 10}km`;
  }
  return `약 ${Math.max(10, Math.round(meters / 10) * 10)}m`;
}

/** 상태 note 안의 "고객사: <이름>" 부분만 새 이름으로 바꾼다(다른 내용은 건드리지 않는다). */
export function replaceClientInNote(note: string, oldName: string, newName: string): string {
  const oldToken = `고객사: ${oldName}`;
  return note.includes(oldToken) ? note.split(oldToken).join(`고객사: ${newName}`) : note;
}

/** 위치 불일치로 막힌 등록 요청(body)의 고객사를 새 고객사로 바꾼다. 담당자는 고객사마다 달라 새로 지정한 것만 쓴다. */
export function applyClientSwitchToBody(
  body: Record<string, unknown>,
  oldName: string,
  next: { name: string; clientId?: string; contact?: { contactId?: string; contactName?: string; contactPhone?: string } }
): void {
  const effort = body.effort as Record<string, unknown> | undefined;
  if (!effort) return;
  effort.clientName = next.name;
  if (next.clientId) effort.clientId = next.clientId; else delete effort.clientId;
  delete effort.contactId;
  delete effort.contactName;
  delete effort.contactPhone;
  if (next.contact?.contactId) effort.contactId = next.contact.contactId;
  else if (next.contact?.contactName?.trim()) {
    effort.contactName = next.contact.contactName.trim();
    if (next.contact.contactPhone?.trim()) effort.contactPhone = next.contact.contactPhone.trim();
  }
  if (typeof body.note === 'string') body.note = replaceClientInNote(body.note, oldName, next.name);
}
