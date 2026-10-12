import { normalizeName, isInternalClientKey } from './project-backfill-plan';

/**
 * 2026-10-08: 직원 입력을 "덜 누르게" 하고, 프로젝트에 연결되지 않은 공수를 관리자가 한곳에서 정리하게 하는
 * 순수 계산 모듈(DB 접근 없음 → 단위 테스트 가능).
 */

// ───────────────────────── 1) 직원 입력 기본값(지난번에 쓴 값) ─────────────────────────

/** 고객사 작업유형 목록(정기점검/신규설치/…)을 쓰는 상태. 미팅목적·본사근무처럼 다른 목록을 쓰는 상태는 제외한다. */
export const WORK_TYPE_SOURCE_STATUSES = new Set(['CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK']);

export interface RecentEffort {
  clientName: string;
  workType: string | null;
  projectId: string | null;
  sourceStatus: string | null;
  description: string | null;
}
export interface ClientDefault {
  clientName: string;
  workType: string | null;
  projectId: string | null;
}

/**
 * 최근 공수(최신순으로 정렬되어 들어옴)에서 고객사별 "지난번에 쓴 작업유형/프로젝트"를 뽑는다.
 * - 작업유형: 작업유형 직접 선택 상태의 가장 최근 값. 즉시등록이 서버 기본값으로 남긴 '기타'(작업내용 없음)는 제외.
 * - 프로젝트: 프로젝트가 연결된 가장 최근 기록의 값.
 */
export function pickClientDefaults(rowsNewestFirst: RecentEffort[]): ClientDefault[] {
  const byKey = new Map<string, ClientDefault>();
  for (const r of rowsNewestFirst) {
    const key = normalizeName(r.clientName);
    if (!key || isInternalClientKey(key)) continue;
    let cur = byKey.get(key);
    if (!cur) { cur = { clientName: r.clientName, workType: null, projectId: null }; byKey.set(key, cur); }
    if (cur.workType === null && r.workType && r.sourceStatus && WORK_TYPE_SOURCE_STATUSES.has(r.sourceStatus)) {
      const placeholder = r.workType === '기타' && !(r.description ?? '').trim();
      if (!placeholder) cur.workType = r.workType;
    }
    if (cur.projectId === null && r.projectId) cur.projectId = r.projectId;
  }
  return [...byKey.values()].filter((d) => d.workType || d.projectId);
}

// ───────────────────────── 2) 프로젝트에 연결되지 않은 공수 모아보기 ─────────────────────────

export interface UnlinkedGroupInput { clientName: string; logCount: number; minutes: number; lastDate: string | null }
export interface PlanClient { id: string; name: string }
export interface PlanProject { id: string; code: string; name: string; clientId: string | null; status: string }
export interface UnlinkedGroup {
  key: string;
  names: string[];
  logCount: number;
  minutes: number;
  lastDate: string | null;
  registeredClient: PlanClient | null;
  suggestedProject: { id: string; code: string; name: string } | null;
}

const STATUS_RANK: Record<string, number> = { ACTIVE: 0, PLANNED: 1, ON_HOLD: 2, COMPLETED: 3, CANCELLED: 4 };

/** 같은 고객사로 볼 수 있는 표기(예: "(주)코스콤" / "코스콤")를 묶고, 등록된 고객사·기존 프로젝트를 제안한다. */
export function groupUnlinked(rows: UnlinkedGroupInput[], clients: PlanClient[], projects: PlanProject[]): UnlinkedGroup[] {
  const clientsByKey = new Map<string, PlanClient[]>();
  for (const c of clients) {
    const k = normalizeName(c.name);
    if (!k) continue;
    clientsByKey.set(k, [...(clientsByKey.get(k) ?? []), c]);
  }
  const groups = new Map<string, UnlinkedGroup>();
  for (const r of rows) {
    const key = normalizeName(r.clientName);
    if (!key || isInternalClientKey(key)) continue;
    const g = groups.get(key) ?? { key, names: [], logCount: 0, minutes: 0, lastDate: null, registeredClient: null, suggestedProject: null };
    if (!g.names.includes(r.clientName)) g.names.push(r.clientName);
    g.logCount += r.logCount;
    g.minutes += r.minutes;
    if (r.lastDate && (!g.lastDate || r.lastDate > g.lastDate)) g.lastDate = r.lastDate;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const matches = clientsByKey.get(g.key) ?? [];
    if (matches.length === 1) {
      g.registeredClient = matches[0];
      const candidates = projects
        .filter((p) => p.clientId === matches[0].id)
        .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.code.localeCompare(b.code));
      if (candidates[0]) g.suggestedProject = { id: candidates[0].id, code: candidates[0].code, name: candidates[0].name };
    }
  }
  return [...groups.values()].sort((a, b) => (b.lastDate ?? '').localeCompare(a.lastDate ?? '') || b.minutes - a.minutes);
}

// ───────────────────────── 3) PM 후보(공수가 가장 많은 엔지니어) ─────────────────────────

export interface EngineerTotal { projectId: string; userId: string; minutes: number; logCount: number; lastDate: string | null }

/** 프로젝트별로 공수(분)가 가장 많은 엔지니어. 동률이면 기록 수 → 최근 작업일 순으로 정한다. */
export function pickTopEngineers(rows: EngineerTotal[]): Map<string, EngineerTotal> {
  const best = new Map<string, EngineerTotal>();
  for (const r of rows) {
    const cur = best.get(r.projectId);
    if (!cur) { best.set(r.projectId, r); continue; }
    const better = r.minutes !== cur.minutes ? r.minutes > cur.minutes
      : r.logCount !== cur.logCount ? r.logCount > cur.logCount
      : (r.lastDate ?? '') > (cur.lastDate ?? '');
    if (better) best.set(r.projectId, r);
  }
  return best;
}
