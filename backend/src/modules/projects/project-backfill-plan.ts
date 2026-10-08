/**
 * 2026-10-08: 공수(EffortLog) 데이터로 프로젝트를 자동 생성하기 위한 "순수 계산" 모듈.
 * DB를 전혀 건드리지 않는다 — 입력(공수 행/등록 고객사/기존 프로젝트)을 받아 "어떤 프로젝트를
 * 만들고 어떤 공수를 연결할지" 계획만 돌려준다. 그래서 미리보기(dry-run)와 실제 적용이 같은
 * 계산을 쓰고, DB 없이도 단위 테스트가 가능하다.
 *
 * 사용자 결정(2026-10-08):
 *  1) 고객사 1곳 = 프로젝트 1개. 이름 표기만 다른 같은 고객사는 자동 정규화로 합치고, 비슷하지만
 *     불확실한 후보는 사람이 합칠지 결정한다(similarPairs). 구체 작업명은 그 프로젝트의 Task.
 *  2) 의미 있는 고객사만: 공수 2건 이상 OR 누적 8시간 이상 OR 구체 작업명이 있는 고객사.
 *  3) 마지막 공수가 30일 이내면 진행(ACTIVE), 이후는 완료(COMPLETED).
 */

export const ACTIVE_WINDOW_DAYS = 30;
export const MEANINGFUL_MIN_LOGS = 2;
export const MEANINGFUL_MIN_MINUTES = 8 * 60;

// 고객사가 아닌 "내부" 표기들(정규화된 형태). 이런 이름으로는 프로젝트를 만들지 않는다.
const INTERNAL_CLIENT_KEYS = new Set([
  '본사', '본사업무', '본사근무', '본서', '사내', '사내업무', '내부', '내부업무', '내부작업',
  'dsti', 'dsti본사', 'dstitsb', '신한이노플렉스2차dsti본사',
  '없음', '해당없음', '미정', '기타', 'na', 'none', 'null',
]);

// 고객사 작업이 아닌 업무 유형(식사/자기계발/내부 회의 등) — 프로젝트 공수로 보지 않는다.
export const DEFAULT_EXCLUDED_WORK_TYPES = ['식사', '셀프스터디', '교육', '내부미팅'];

// 2026-10-08: "이름이 포함 관계면 같은 고객사"로 자동 합칠 때, 포함되는 쪽(짧은 이름)이 이런 일반 단어뿐이면
// 서로 다른 고객사가 같은 단어를 공유하는 경우일 수 있어 합치지 않는다(예: "…데이터센터", "…법률사무소").
const GENERIC_NAME_KEYS = new Set([
  '데이터센터', '연구센터', '교육센터', '법률사무소', '대학교', '대학병원', '금융그룹', '은행본점',
  '본점', '지점', '센터', '사무소', '연구소', '병원', '증권', '보험', '은행', '캐피탈', '카드', '그룹',
]);

// 구체 작업명으로 보지 않는 값.
const GENERIC_TASK_KEYS = new Set(['', '-', '없음', '해당없음', '미정', '기타', '일반', 'na', 'none', 'null']);

/** 고객사/작업명 비교용 키: 대소문자·공백·괄호·(주)·기호를 제거한다. */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(株\)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function isInternalClientKey(key: string): boolean {
  if (!key) return true;
  if (INTERNAL_CLIENT_KEYS.has(key)) return true;
  if (key.startsWith('sample')) return true;
  return false;
}

export interface EffortRow {
  id: string;
  userId: string;
  workDate: Date;
  clientName: string;
  projectName: string;
  workType: string;
  minutes: number; // actualMinutes ?? minutes ?? 0
  sourceStatus: string | null;
}
export interface ClientRow { id: string; name: string }
export interface ExistingProject { id: string; code: string; name: string; clientId: string | null; status: string }
export interface UserRef { id: string; name: string }

export interface PlannedTask {
  key: string;
  title: string;
  assigneeId: string | null;
  status: 'IN_PROGRESS' | 'DONE';
  logCount: number;
  lastDate: string;
  logIds: string[];
}
export interface PlannedProject {
  key: string;
  name: string;
  clientId: string | null;
  existing: { id: string; code: string } | null;
  logCount: number;
  totalMinutes: number;
  engineers: { userId: string; name: string; logCount: number }[];
  firstDate: string;
  lastDate: string;
  status: 'ACTIVE' | 'COMPLETED';
  meaningful: boolean;
  /** 실제로 만들거나 연결할 대상인지 (의미 있음 OR 이미 같은 프로젝트가 존재) */
  include: boolean;
  tasks: PlannedTask[];
  /** 이 프로젝트에 연결될 공수 id 전체(Task에 연결되는 것 포함). */
  logIds: string[];
  rawNames: string[];
}
export interface SimilarPair {
  a: string; // PlannedProject.key
  b: string;
  reason: 'CONTAINS' | 'TYPO';
  aName: string;
  bName: string;
  aLogs: number;
  bLogs: number;
}
export interface BackfillPlan {
  projects: PlannedProject[];
  similarPairs: SimilarPair[];
  /** 이름 포함 관계 쌍 전체(개수 제한 없음) — "포함 관계면 자동 합치기" 옵션이 쓴다. */
  containsPairs: [string, string][];
  skipped: {
    totalLogs: number;
    alreadyLinked: number;
    emptyClient: number;
    internalClient: number;
    excludedWorkType: number;
    sampleUser: number;
    notMeaningfulClients: number;
    notMeaningfulLogs: number;
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}
function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v.length < best.length)) { best = v; bestCount = c; }
  }
  return best;
}

function levenshteinAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

export interface BuildPlanInput {
  /** 아직 프로젝트에 연결되지 않은(project_id IS NULL) 공수만 넣는다. */
  rows: EffortRow[];
  clients: ClientRow[];
  existingProjects: ExistingProject[];
  users: UserRef[];
  /** SAMPLE_ 계정 id 집합 — 이 계정의 공수는 계획에서 제외한다. */
  sampleUserIds: Set<string>;
  /** 기준일(KST 날짜 yyyy-mm-dd). */
  today: string;
  excludedWorkTypes?: string[];
  /** 이미 연결된 공수 건수(통계용). */
  alreadyLinkedCount?: number;
}

export function buildBackfillPlan(input: BuildPlanInput): BackfillPlan {
  const excluded = new Set((input.excludedWorkTypes ?? DEFAULT_EXCLUDED_WORK_TYPES).map((s) => s.trim()));
  const userName = new Map(input.users.map((u) => [u.id, u.name]));
  const skipped: BackfillPlan['skipped'] = {
    totalLogs: input.rows.length,
    alreadyLinked: input.alreadyLinkedCount ?? 0,
    emptyClient: 0, internalClient: 0, excludedWorkType: 0, sampleUser: 0,
    notMeaningfulClients: 0, notMeaningfulLogs: 0,
  };

  // 등록 고객사: 정규화 이름 -> 고객사(같은 이름이 여러 개면 id가 작은 쪽을 쓴다 — 결정적 선택)
  const clientByKey = new Map<string, ClientRow>();
  for (const c of [...input.clients].sort((x, y) => x.id.localeCompare(y.id))) {
    const k = normalizeName(c.name);
    if (k && !clientByKey.has(k)) clientByKey.set(k, c);
  }
  const existingByClient = new Map<string, ExistingProject>();
  const existingByNameKey = new Map<string, ExistingProject>();
  const rank = (s: string) => (s === 'ACTIVE' ? 0 : s === 'PLANNED' ? 1 : s === 'ON_HOLD' ? 2 : s === 'COMPLETED' ? 3 : 9);
  for (const p of input.existingProjects) {
    if (p.status === 'CANCELLED') continue;
    if (p.clientId) {
      const cur = existingByClient.get(p.clientId);
      if (!cur || rank(p.status) < rank(cur.status)) existingByClient.set(p.clientId, p);
    } else {
      const k = normalizeName(p.name);
      if (k && !existingByNameKey.has(k)) existingByNameKey.set(k, p);
    }
  }

  const groups = new Map<string, EffortRow[]>();
  for (const r of input.rows) {
    if (input.sampleUserIds.has(r.userId)) { skipped.sampleUser++; continue; }
    const key = normalizeName(r.clientName);
    if (!key) { skipped.emptyClient++; continue; }
    if (isInternalClientKey(key)) { skipped.internalClient++; continue; }
    if (excluded.has((r.workType ?? '').trim())) { skipped.excludedWorkType++; continue; }
    const list = groups.get(key);
    if (list) list.push(r); else groups.set(key, [r]);
  }

  const projects: PlannedProject[] = [];
  for (const [key, rows] of groups) {
    const registered = clientByKey.get(key) ?? null;
    const existing = registered ? existingByClient.get(registered.id) ?? null : existingByNameKey.get(key) ?? null;

    // 구체 작업명 -> Task 후보
    const taskGroups = new Map<string, EffortRow[]>();
    for (const r of rows) {
      const tk = normalizeName(r.projectName);
      if (GENERIC_TASK_KEYS.has(tk) || tk === key || isInternalClientKey(tk)) continue;
      const title = r.projectName.trim();
      if (title.length < 2 || title.length > 100) continue;
      const list = taskGroups.get(tk);
      if (list) list.push(r); else taskGroups.set(tk, [r]);
    }

    const dates = rows.map((r) => ymd(r.workDate)).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const totalMinutes = rows.reduce((s, r) => s + (r.minutes || 0), 0);
    const meaningful = rows.length >= MEANINGFUL_MIN_LOGS || totalMinutes >= MEANINGFUL_MIN_MINUTES || taskGroups.size > 0;

    const engCount = new Map<string, number>();
    for (const r of rows) engCount.set(r.userId, (engCount.get(r.userId) ?? 0) + 1);
    const engineers = [...engCount.entries()]
      .map(([userId, logCount]) => ({ userId, name: userName.get(userId) ?? userId, logCount }))
      .sort((a, b) => b.logCount - a.logCount || a.name.localeCompare(b.name));

    const tasks: PlannedTask[] = [...taskGroups.entries()].map(([tk, trs]): PlannedTask => {
      const tDates = trs.map((r) => ymd(r.workDate)).sort();
      const tLast = tDates[tDates.length - 1];
      const eng = new Map<string, number>();
      for (const r of trs) eng.set(r.userId, (eng.get(r.userId) ?? 0) + 1);
      const assignee = [...eng.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
      return {
        key: tk,
        title: mostFrequent(trs.map((r) => r.projectName.trim())),
        assigneeId: assignee,
        status: daysBetween(input.today, tLast) <= ACTIVE_WINDOW_DAYS ? 'IN_PROGRESS' : 'DONE',
        logCount: trs.length,
        lastDate: tLast,
        logIds: trs.map((r) => r.id),
      };
    }).sort((a, b) => b.logCount - a.logCount || a.title.localeCompare(b.title));

    const name = registered?.name ?? existing?.name ?? mostFrequent(rows.map((r) => r.clientName.trim()));
    projects.push({
      key,
      name,
      clientId: registered?.id ?? null,
      existing: existing ? { id: existing.id, code: existing.code } : null,
      logCount: rows.length,
      totalMinutes,
      engineers,
      firstDate,
      lastDate,
      status: daysBetween(input.today, lastDate) <= ACTIVE_WINDOW_DAYS ? 'ACTIVE' : 'COMPLETED',
      meaningful,
      include: meaningful || Boolean(existing),
      tasks,
      logIds: rows.map((r) => r.id),
      rawNames: [...new Set(rows.map((r) => r.clientName.trim()))].slice(0, 6),
    });
  }

  for (const p of projects) {
    if (!p.include) { skipped.notMeaningfulClients++; skipped.notMeaningfulLogs += p.logCount; }
  }

  projects.sort((a, b) => Number(b.include) - Number(a.include) || b.logCount - a.logCount || a.name.localeCompare(b.name));

  // 비슷한 이름 후보 — 사람이 합칠지 결정한다(자동으로 합치지 않음).
  const similarPairs: SimilarPair[] = [];
  const containsPairs: [string, string][] = [];
  const withKey = projects.filter((p) => p.key.length >= 3);
  for (let i = 0; i < withKey.length; i++) {
    for (let j = i + 1; j < withKey.length; j++) {
      const a = withKey[i];
      const b = withKey[j];
      if (!a.include && !b.include) continue; // 둘 다 연결 대상이 아니면 의미 없음
      let reason: SimilarPair['reason'] | null = null;
      if (a.key.includes(b.key) || b.key.includes(a.key)) {
        const shorter = a.key.length <= b.key.length ? a.key : b.key;
        if (!GENERIC_NAME_KEYS.has(shorter)) reason = 'CONTAINS';
      } else if (Math.min(a.key.length, b.key.length) >= 4 && levenshteinAtMost1(a.key, b.key)) reason = 'TYPO';
      if (!reason) continue;
      // 서로 다른 등록 고객사에 각각 매칭된 경우는 "다른 지점"일 가능성이 높아 합치기 후보에서 제외
      if (a.clientId && b.clientId && a.clientId !== b.clientId) continue;
      if (reason === 'CONTAINS') containsPairs.push([a.key, b.key]);
      similarPairs.push({ a: a.key, b: b.key, reason, aName: a.name, bName: b.name, aLogs: a.logCount, bLogs: b.logCount });
    }
  }
  similarPairs.sort((x, y) => (y.aLogs + y.bLogs) - (x.aLogs + x.bLogs));
  return { projects, similarPairs: similarPairs.slice(0, 200), containsPairs, skipped };
}

/**
 * 관리자가 승인한 합치기 쌍(pairs)과 제외 키(excludeKeys)를 반영해 계획을 다시 만든다.
 * 합칠 때는 공수 건수가 가장 많은 쪽을 대표로 삼고, 이름이 다른 쪽은 rawNames에 남긴다.
 */
export function applyMergesAndExcludes(
  plan: BackfillPlan,
  mergePairs: [string, string][],
  excludeKeys: string[],
  today: string,
): PlannedProject[] {
  const byKey = new Map(plan.projects.map((p) => [p.key, p]));
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let cur = k;
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  for (const [a, b] of mergePairs) {
    if (!byKey.has(a) || !byKey.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const pa = byKey.get(ra)!;
    const pb = byKey.get(rb)!;
    // 대표: 등록 고객사와 매칭된 쪽 > 공수 많은 쪽 > 이름이 긴 쪽
    const winner = pa.clientId && !pb.clientId ? ra
      : pb.clientId && !pa.clientId ? rb
      : pa.logCount !== pb.logCount ? (pa.logCount > pb.logCount ? ra : rb)
      : (pa.key.length >= pb.key.length ? ra : rb); // 공수 건수가 같으면 더 구체적인(긴) 이름을 대표로
    const loser = winner === ra ? rb : ra;
    parent.set(loser, winner);
    parent.set(winner, winner);
  }

  const merged = new Map<string, PlannedProject>();
  const absorb = (base: PlannedProject, p: PlannedProject) => {
    base.logCount += p.logCount;
    base.totalMinutes += p.totalMinutes;
    base.logIds.push(...p.logIds);
    base.rawNames = [...new Set([...base.rawNames, ...p.rawNames])].slice(0, 8);
    for (const e of p.engineers) {
      const ex = base.engineers.find((x) => x.userId === e.userId);
      if (ex) ex.logCount += e.logCount; else base.engineers.push({ ...e });
    }
    for (const t of p.tasks) {
      const ex = base.tasks.find((x) => x.key === t.key);
      if (ex) {
        ex.logCount += t.logCount;
        ex.logIds.push(...t.logIds);
        if (t.lastDate > ex.lastDate) { ex.lastDate = t.lastDate; ex.status = t.status; }
      } else base.tasks.push({ ...t, logIds: [...t.logIds] });
    }
    if (p.firstDate < base.firstDate) base.firstDate = p.firstDate;
    if (p.lastDate > base.lastDate) base.lastDate = p.lastDate;
    base.existing = base.existing ?? p.existing;
    base.meaningful = base.meaningful || p.meaningful;
  };
  for (const p of plan.projects) {
    const root = find(p.key);
    let base = merged.get(root);
    if (!base) {
      // 대표(root) 프로젝트의 이름/고객사/기존 프로젝트를 기준으로 시작한다(대표 자신의 내용은 여기서 한 번만 담긴다).
      const r = byKey.get(root)!;
      base = { ...r, engineers: r.engineers.map((e) => ({ ...e })), tasks: r.tasks.map((t) => ({ ...t, logIds: [...t.logIds] })), logIds: [...r.logIds], rawNames: [...r.rawNames] };
      merged.set(root, base);
    }
    if (p.key !== root) absorb(base, p);
  }
  const exclude = new Set(excludeKeys);
  const out: PlannedProject[] = [];
  for (const p of merged.values()) {
    p.engineers.sort((a, b) => b.logCount - a.logCount || a.name.localeCompare(b.name));
    p.status = daysBetween(today, p.lastDate) <= ACTIVE_WINDOW_DAYS ? 'ACTIVE' : 'COMPLETED';
    // 합친 뒤 합계로 다시 "의미 있음" 판정
    p.meaningful = p.meaningful || p.logCount >= MEANINGFUL_MIN_LOGS || p.totalMinutes >= MEANINGFUL_MIN_MINUTES || p.tasks.length > 0;
    p.include = (p.meaningful || Boolean(p.existing)) && !exclude.has(p.key);
    out.push(p);
  }
  out.sort((a, b) => Number(b.include) - Number(a.include) || b.logCount - a.logCount || a.name.localeCompare(b.name));
  return out;
}
