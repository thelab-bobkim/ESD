import { randomUUID } from 'crypto';
import { getPolicyJSON, setPolicyJSON } from '../../common/policy-engine/policy-engine';
import { haversineMeters } from './client-duplicates';

/**
 * 2026-10-13: "등록된 고객사 위치가 실제와 달라요" 신청 — 직원이 앱에서 지도로 확인한 위치를 올리면, 관리자가 확인한 뒤에만
 * 그 고객사의 등록 좌표에 반영한다(직원이 올린 값이 바로 기준 좌표가 되면 잘못 누르거나 속인 위치가 기준이 될 수 있어서).
 * 서로 다른 직원 여러 명이 같은 곳을 올리면 그 평균을 제안 좌표로 쓴다.
 *
 * 저장소: DB 구조를 바꾸지 않으려고 정책값(policy_settings)의 JSON 한 칸에 "대기 중인 신청"만 보관한다.
 * 처리(승인/반려)되면 목록에서 빠지면서 좌표도 함께 사라지고, 30일이 지난 신청도 자동으로 정리된다.
 * 처리 내역(누가·무엇을·어떻게)은 감사로그에 남는다.
 */
export const PROPOSALS_KEY = 'CLIENT_LOCATION_PROPOSALS';
export const PROPOSAL_TTL_DAYS = 30;
export const PROPOSAL_CLUSTER_RADIUS_METERS = 300;
export const MAX_PROPOSALS_TOTAL = 300;
export const MAX_PROPOSALS_PER_USER = 5;
/** 신청에 쓸 수 있는 GPS 오차범위 상한 — 부정확한 측정으로 기준 좌표를 바꾸지 못하게 한다. */
export const PROPOSAL_MAX_ACCURACY_METERS = 300;
/** 직원이 지도에서 확정한 위치는 이번에 측정된 GPS 지점에서 이 거리 안이어야 한다(서버의 정정 허용 범위와 같은 값). */
export const PROPOSAL_MAX_PIN_DISTANCE_METERS = 1000;

export interface LocationProposal {
  id: string;
  userId: string;
  userName: string;
  createdAt: string;
  status: string;
  clientId: string;
  clientName: string;
  /** 소수 4자리(약 10m) */
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  /** 신청 당시 등록 좌표까지의 거리(m) */
  distanceMeters: number;
  note: string | null;
}

export const roundCoord = (v: number) => Math.round(v * 1e4) / 1e4;

export function purgeExpired(list: LocationProposal[], now: Date = new Date(), days = PROPOSAL_TTL_DAYS): LocationProposal[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return list.filter((p) => new Date(p.createdAt).getTime() >= cutoff);
}

/** 같은 직원이 같은 고객사로 다시 올리면 이전 신청을 대체하고, 직원당·전체 상한을 넘으면 오래된 것부터 버린다. */
export function upsertProposal(list: LocationProposal[], next: LocationProposal): LocationProposal[] {
  let out = list.filter((p) => !(p.userId === next.userId && p.clientId === next.clientId));
  out.push(next);
  const mine = out.filter((p) => p.userId === next.userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (mine.length > MAX_PROPOSALS_PER_USER) {
    const drop = new Set(mine.slice(0, mine.length - MAX_PROPOSALS_PER_USER).map((p) => p.id));
    out = out.filter((p) => !drop.has(p.id));
  }
  if (out.length > MAX_PROPOSALS_TOTAL) {
    out = [...out].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(out.length - MAX_PROPOSALS_TOTAL);
  }
  return out;
}

export interface ProposalCluster {
  /** 대표 신청(가장 최근 것) */
  representative: LocationProposal;
  clientId: string;
  members: LocationProposal[];
  userNames: string[];
  userCount: number;
  /** 서로 다른 직원이 올린 최신 위치들의 평균 */
  centerLat: number;
  centerLng: number;
}

function buildCluster(members: LocationProposal[]): ProposalCluster {
  const sorted = [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestPerUser = new Map<string, LocationProposal>();
  for (const m of sorted) if (!latestPerUser.has(m.userId)) latestPerUser.set(m.userId, m);
  const pts = [...latestPerUser.values()];
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  return {
    representative: sorted[0],
    clientId: sorted[0].clientId,
    members: sorted,
    userNames: pts.map((p) => p.userName),
    userCount: pts.length,
    centerLat: roundCoord(lat),
    centerLng: roundCoord(lng),
  };
}

/** 같은 고객사에 대해 서로 가까운(반경 이내) 신청끼리 묶는다. 최근 신청이 위에 오도록 정렬한다. */
export function groupProposals(list: LocationProposal[], radius = PROPOSAL_CLUSTER_RADIUS_METERS): ProposalCluster[] {
  const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groups: LocationProposal[][] = [];
  for (const p of sorted) {
    const g = groups.find((grp) => grp[0].clientId === p.clientId && haversineMeters(grp[0].lat, grp[0].lng, p.lat, p.lng) <= radius);
    if (g) g.push(p); else groups.push([p]);
  }
  return groups.map(buildCluster);
}

/** 한 신청과 같은 묶음(같은 고객사 + 반경 이내)에 속한 모든 신청. 처리(승인/반려)는 이 묶음 단위로 한다. */
export function clusterOf(list: LocationProposal[], id: string, radius = PROPOSAL_CLUSTER_RADIUS_METERS): ProposalCluster | null {
  const target = list.find((p) => p.id === id);
  if (!target) return null;
  const members = list.filter((p) => p.clientId === target.clientId && haversineMeters(target.lat, target.lng, p.lat, p.lng) <= radius);
  return buildCluster(members);
}

export function newProposalId(): string {
  return randomUUID();
}

export async function loadProposals(now: Date = new Date()): Promise<LocationProposal[]> {
  const raw = await getPolicyJSON<LocationProposal[]>(PROPOSALS_KEY, []);
  return purgeExpired(Array.isArray(raw) ? raw : [], now);
}

export async function saveProposals(list: LocationProposal[]): Promise<void> {
  await setPolicyJSON(PROPOSALS_KEY, list);
}
