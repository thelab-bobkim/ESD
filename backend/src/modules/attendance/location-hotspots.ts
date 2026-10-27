import { haversineMeters } from '../clients/client-duplicates';

/**
 * 2026-10-13: "같은 장소에서 여러 사람이 반복해서 위치 불일치가 나면" 그 이유가 직원 실수가 아니라 고객사 위치(좌표) 쪽일 수 있다.
 * 관리자가 "고객사 위치관리"에서 새 방문지를 등록하거나 좌표를 바로잡도록 근거를 모아 보여주는 순수 함수들.
 *  - clusterMismatchPoints/classifyHotspots: 불일치로 남은 위치(관리자 전용 보관 좌표, 보관기간 내)를 가까운 것끼리 묶어 "미등록 방문지 후보"를 찾는다.
 *  - summarizeBlockedEvents: 엄격 모드로 등록이 막힌 기록(좌표 없이 고객사명·거리만 남김)을 고객사별로 모아, 여러 명이 반복해서 막히는 고객사를 찾는다.
 */
export interface MismatchPoint {
  userId: string;
  userName: string;
  lat: number;
  lng: number;
  changedAt: Date;
  status: string;
  clientName: string | null;
  /** 이 직원의 배정 고객사(상주지) 좌표 — 상주 직원이 상주지 근처에서 한 등록은 문제 장소로 보지 않는다. */
  residentLat?: number | null;
  residentLng?: number | null;
}

export interface Cluster {
  lat: number;
  lng: number;
  points: MismatchPoint[];
}

export const HOTSPOT_CLUSTER_RADIUS_METERS = 300;
export const HOTSPOT_NEAR_REGISTERED_METERS = 1000;

/** 상태 note 안의 "고객사: <이름> |" 에서 이름을 꺼낸다. 없으면 null. */
export function parseClientFromNote(note: string | null | undefined): string | null {
  const m = (note ?? '').match(/고객사: ([^|]+?)(?: \||$)/);
  const name = m?.[1]?.trim();
  return name && name !== '-' ? name : null;
}

/** 가까운 지점끼리(반경 이내) 묶는다 — 시간순으로 훑으며 가장 가까운 묶음에 넣고, 묶음의 중심은 평균으로 갱신한다. */
export function clusterMismatchPoints(points: MismatchPoint[], radiusMeters = HOTSPOT_CLUSTER_RADIUS_METERS): Cluster[] {
  const clusters: Cluster[] = [];
  const sorted = [...points].sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  for (const p of sorted) {
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const c of clusters) {
      const d = haversineMeters(c.lat, c.lng, p.lat, p.lng);
      if (d <= radiusMeters && d < bestD) { best = c; bestD = d; }
    }
    if (best) {
      const n = best.points.length;
      best.lat = (best.lat * n + p.lat) / (n + 1);
      best.lng = (best.lng * n + p.lng) / (n + 1);
      best.points.push(p);
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, points: [p] });
    }
  }
  return clusters;
}

export interface Hotspot {
  kind: 'UNREGISTERED' | 'NEAR_OTHER_CLIENT';
  count: number;
  userCount: number;
  userNames: string[];
  firstDate: string;
  lastDate: string;
  statuses: string[];
  chosenClients: { name: string; count: number }[];
  nearestClient: { name: string; distanceMeters: number } | null;
  /** 묶음 중심(소수 셋째 자리 ≈ 100m 단위로만 내려준다 — 관리자가 지도에서 위치를 찾아 등록하는 용도). */
  centerLat: number;
  centerLng: number;
}

function ymdKst(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 묶음 중에서 "반복된" 것(서로 다른 직원 2명 이상, 또는 3건 이상)만 골라 분류한다.
 * - 본사 반경 안: 본사에서 원격으로 한 작업을 현장으로 잘못 고른 경우라 후보에서 뺀다.
 * - 등록된 고객사가 반경 안에 있음: 그 고객사 좌표가 어긋났거나 근처 다른 지점을 잘못 고른 경우(NEAR_OTHER_CLIENT).
 * - 가까운 등록 고객사가 없음: 아직 등록되지 않은 방문지 후보(UNREGISTERED).
 */
export function classifyHotspots(
  clusters: Cluster[],
  clients: { name: string; latitude: number | null; longitude: number | null }[],
  hq: { lat: number; lng: number } | null,
  opts: { nearMeters?: number; minUsers?: number; minRecords?: number } = {}
): { hotspots: Hotspot[]; hqAreaClusters: number; residentAreaClusters: number } {
  const nearMeters = opts.nearMeters ?? HOTSPOT_NEAR_REGISTERED_METERS;
  const minUsers = opts.minUsers ?? 2;
  const minRecords = opts.minRecords ?? 3;
  const located = clients.filter((c): c is { name: string; latitude: number; longitude: number } => c.latitude != null && c.longitude != null);
  const out: Hotspot[] = [];
  let hqAreaClusters = 0;
  let residentAreaClusters = 0;
  for (const c of clusters) {
    const users = new Map<string, string>();
    c.points.forEach((p) => users.set(p.userId, p.userName));
    if (users.size < minUsers && c.points.length < minRecords) continue;
    if (hq && haversineMeters(c.lat, c.lng, hq.lat, hq.lng) <= nearMeters) { hqAreaClusters += 1; continue; }
    let nearest: { name: string; distanceMeters: number } | null = null;
    for (const cl of located) {
      const d = Math.round(haversineMeters(c.lat, c.lng, cl.latitude, cl.longitude));
      if (!nearest || d < nearest.distanceMeters) nearest = { name: cl.name, distanceMeters: d };
    }
    // 묶음에 포함된 모든 직원이 "배정 고객사(상주지)가 이 묶음 근처"인 상주 직원이면 상주 근무지라 문제 장소가 아니다.
    const byUser = new Map<string, MismatchPoint>();
    c.points.forEach((p) => { if (!byUser.has(p.userId)) byUser.set(p.userId, p); });
    const allResident = [...byUser.values()].every((p) => p.residentLat != null && p.residentLng != null && haversineMeters(c.lat, c.lng, p.residentLat, p.residentLng) <= nearMeters);
    if (allResident) { residentAreaClusters += 1; continue; }
    const chosen = new Map<string, number>();
    c.points.forEach((p) => { if (p.clientName) chosen.set(p.clientName, (chosen.get(p.clientName) ?? 0) + 1); });
    const times = c.points.map((p) => p.changedAt.getTime());
    out.push({
      kind: nearest && nearest.distanceMeters <= nearMeters ? 'NEAR_OTHER_CLIENT' : 'UNREGISTERED',
      count: c.points.length,
      userCount: users.size,
      userNames: [...users.values()].slice(0, 5),
      firstDate: ymdKst(new Date(Math.min(...times))),
      lastDate: ymdKst(new Date(Math.max(...times))),
      statuses: [...new Set(c.points.map((p) => p.status))],
      chosenClients: [...chosen.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 3),
      nearestClient: nearest,
      centerLat: Math.round(c.lat * 1000) / 1000,
      centerLng: Math.round(c.lng * 1000) / 1000,
    });
  }
  out.sort((a, b) => b.userCount - a.userCount || b.count - a.count);
  return { hotspots: out, hqAreaClusters, residentAreaClusters };
}

export interface BlockedEvent {
  userId: string;
  userName: string;
  kind: 'CLIENT' | 'HQ';
  clientName: string | null;
  distanceMeters: number | null;
}

export interface BlockedClientSummary {
  clientName: string;
  count: number;
  userCount: number;
  userNames: string[];
  medianDistanceMeters: number | null;
  /** 서로 다른 직원 2명 이상이 반복해서 막힌 고객사 — 직원 실수보다 등록 좌표 쪽을 먼저 의심한다. */
  suspectCoordinates: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function summarizeBlockedEvents(events: BlockedEvent[]): { clients: BlockedClientSummary[]; hq: { count: number; userCount: number; medianDistanceMeters: number | null } } {
  const by = new Map<string, BlockedEvent[]>();
  const hq: BlockedEvent[] = [];
  for (const e of events) {
    if (e.kind === 'HQ') { hq.push(e); continue; }
    if (!e.clientName) continue;
    const list = by.get(e.clientName) ?? [];
    list.push(e);
    by.set(e.clientName, list);
  }
  const clients: BlockedClientSummary[] = [...by.entries()].map(([clientName, list]) => {
    const users = new Map<string, string>();
    list.forEach((e) => users.set(e.userId, e.userName));
    return {
      clientName,
      count: list.length,
      userCount: users.size,
      userNames: [...users.values()].slice(0, 5),
      medianDistanceMeters: median(list.map((e) => e.distanceMeters).filter((d): d is number => d != null)),
      suspectCoordinates: users.size >= 2,
    };
  }).sort((a, b) => b.userCount - a.userCount || b.count - a.count);
  return {
    clients,
    hq: { count: hq.length, userCount: new Set(hq.map((e) => e.userId)).size, medianDistanceMeters: median(hq.map((e) => e.distanceMeters).filter((d): d is number => d != null)) },
  };
}
