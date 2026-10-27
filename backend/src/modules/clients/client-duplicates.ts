/**
 * 2026-10-13: 같은 고객사가 이름만 다르게 이중 등록된 경우(예: '생물' / '국립생물자원관', 주소 동일)를 찾는 순수 함수들.
 * 자동으로 지우지 않는다 — 어떤 이름이 정확한지는 사람이 정해야 하고, 지우면 프로젝트·담당자·도착체크 연결이 끊길 수 있어서
 * 관리자가 이름을 고르면 연결을 옮긴 뒤 합치는 방식(clients.routes.ts /merge)으로만 정리한다.
 */
export interface DupClient {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

export interface DuplicateGroup {
  /** 정규화된 주소 */
  key: string;
  /** HIGH: 이름이 서로 포함되거나 좌표가 사실상 같음(거의 확실한 중복) / LOW: 주소만 같음(같은 건물의 다른 회사일 수 있음) */
  confidence: 'HIGH' | 'LOW';
  clients: DupClient[];
  /** 남기기를 권하는 쪽(가장 구체적인 이름). 최종 선택은 관리자가 한다. */
  suggestedKeepId: string;
}

const NOISE = /[\p{P}\p{S}\s]/gu;

// 같은 주소가 "인천광역시"/"인천", "경기도"/"경기"처럼 시·도 표기만 다르게 들어간 경우를 같은 주소로 보기 위한 정리.
const REGION_FORMS: [RegExp, string][] = [
  [/(서울|부산|대구|인천|광주|대전|울산)(특별시|광역시)/g, '$1'],
  [/세종특별자치시/g, '세종'],
  [/제주특별자치도/g, '제주'],
  [/강원특별자치도/g, '강원'],
  [/전북특별자치도/g, '전북'],
  [/(경기|강원|제주)도/g, '$1'],
  [/충청북도/g, '충북'], [/충청남도/g, '충남'], [/전라북도/g, '전북'], [/전라남도/g, '전남'], [/경상북도/g, '경북'], [/경상남도/g, '경남'],
];

export function normalizeAddress(a: string): string {
  let s = (a ?? '').replace(NOISE, '').toLowerCase();
  for (const [re, to] of REGION_FORMS) s = s.replace(re, to);
  return s;
}

export function normalizeName(n: string): string {
  return (n ?? '').replace(NOISE, '').toLowerCase();
}

/** 한쪽 이름이 다른 쪽에 포함되면(최소 2글자) 같은 곳을 줄여 부른 이름으로 본다. */
export function namesRelated(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short);
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (v: number) => (v * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sameSpot(a: DupClient, b: DupClient): boolean {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return false;
  return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude) <= 50;
}

/** 두 고객사가 "같은 곳의 중복 등록"으로 보이는지(이름 관계 또는 같은 좌표). */
export function looksLikeSameClient(a: DupClient, b: DupClient): boolean {
  return namesRelated(a.name, b.name) || sameSpot(a, b);
}

export function findDuplicateGroups(clients: DupClient[]): DuplicateGroup[] {
  const byAddress = new Map<string, DupClient[]>();
  for (const c of clients) {
    if (c.name.startsWith('SAMPLE_')) continue;
    const key = normalizeAddress(c.address);
    if (key.length < 6) continue; // 주소가 비었거나 너무 짧으면 비교하지 않는다
    const list = byAddress.get(key) ?? [];
    list.push(c);
    byAddress.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, list] of byAddress) {
    if (list.length < 2) continue;
    let high = false;
    for (let i = 0; i < list.length && !high; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (looksLikeSameClient(list[i], list[j])) { high = true; break; }
      }
    }
    // 가장 구체적인(긴) 이름을 남기기 권장 — 같으면 좌표가 있는 쪽, 그다음 이름순으로 안정적으로 정한다.
    const suggested = [...list].sort((a, b) => {
      const d = normalizeName(b.name).length - normalizeName(a.name).length;
      if (d !== 0) return d;
      const ca = a.latitude != null ? 1 : 0;
      const cb = b.latitude != null ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return a.name.localeCompare(b.name, 'ko');
    })[0];
    groups.push({ key, confidence: high ? 'HIGH' : 'LOW', clients: [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko')), suggestedKeepId: suggested.id });
  }
  return groups.sort((a, b) => (a.confidence === b.confidence ? a.key.localeCompare(b.key) : a.confidence === 'HIGH' ? -1 : 1));
}
