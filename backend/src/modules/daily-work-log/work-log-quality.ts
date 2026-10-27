import { isMeaningfulPlan, normalizePlanText } from './work-log-rules';

/**
 * 2026-10-15: 일일업무일지 점검(순수 함수) — "직원들이 업무일지를 잘 쓰고 있는가, 이 데이터를 활용할 수 있는가"를 본다.
 *  1) 작성률   : 퇴근까지 마친 날 대비 업무일지가 있는 날의 비율(직원별·부서별·일자별)
 *  2) 내용 품질 : 이슈/내일 계획/작업내용이 성의 있게 쓰였는지(빈 값·한 글자·반복 문자·전날 복사)
 *  3) 공수 일치 : 그날 고객사 작업 기록(EffortLog)에 있는 고객사가 일지에 적혔는지, 일지의 방문지에 작업 기록이 있는지
 *  4) 활용 가능성: 방문 고객사가 등록된 고객사명과 매칭되는지(고객사별 집계 가능 여부), 점수 80점 이상 비율
 * DB는 건드리지 않고 조회한 행만 받아 계산한다. 점수는 "참고용 점검 지표"이며 개인 평가 기준이 아니다.
 */

export type QualityFlag =
  | 'PLAN_WEAK'
  | 'ISSUES_JUNK'
  | 'CONTENT_MISSING'
  | 'CONTENT_SHORT'
  | 'CLIENT_NOT_IN_LOG'
  | 'VISIT_WITHOUT_EFFORT'
  | 'COPY_OF_PREVIOUS'
  | 'CLIENT_UNREGISTERED'
  | 'EFFORT_SNAPSHOT_DIFF';

export type QualityGrade = 'GOOD' | 'FAIR' | 'POOR';

export const QUALITY_FLAG_LABELS: Record<QualityFlag, string> = {
  PLAN_WEAK: '내일 예정 업무가 성의 없음',
  ISSUES_JUNK: '이슈/특이사항이 의미 없는 입력',
  CONTENT_MISSING: '작업내용 비어 있음',
  CONTENT_SHORT: '작업내용이 너무 짧음',
  CLIENT_NOT_IN_LOG: '작업한 고객사가 일지에 없음',
  VISIT_WITHOUT_EFFORT: '방문지는 있는데 작업 기록 없음',
  COPY_OF_PREVIOUS: '전날 내용과 동일(복사 의심)',
  CLIENT_UNREGISTERED: '방문지가 등록 고객사와 매칭 안 됨',
  EFFORT_SNAPSHOT_DIFF: '일지 공수와 작업 기록 합계가 크게 다름',
};

const PENALTY: Record<QualityFlag, number> = {
  PLAN_WEAK: 25,
  ISSUES_JUNK: 25,
  CONTENT_MISSING: 35,
  CONTENT_SHORT: 20,
  CLIENT_NOT_IN_LOG: 20,
  VISIT_WITHOUT_EFFORT: 5,
  COPY_OF_PREVIOUS: 20,
  CLIENT_UNREGISTERED: 10,
  EFFORT_SNAPSHOT_DIFF: 5,
};

/** 작업내용이 "있어야 하는" 날의 최소 글자 수(구두점·공백 제외). */
export const MIN_CONTENT_LENGTH = 10;
/** 작업 기록이 이 시간(분) 이상이면 "실제로 고객사 작업을 한 날"로 본다. */
export const MIN_EFFORT_MINUTES = 30;
/** 일지의 공수 스냅샷과 작업 기록 합계가 이 이상 차이나면 표시한다. */
export const EFFORT_DIFF_MINUTES = 60;
export const GOOD_SCORE = 80;
export const FAIR_SCORE = 50;

/** "이슈 없음"을 뜻하는 정당한 답(구두점·공백 제거 후 일치) — 의미 없는 입력으로 보지 않는다. */
const ISSUES_NONE = new Set([
  '없음', '없습니다', '없어요', '없다', '이상없음', '이상없습니다', '이슈없음', '이슈없습니다', '문제없음', '문제없습니다',
  '특이사항없음', '특이사항없습니다', '특이사항은없음', '특이사항은없습니다', '해당없음', '해당사항없음', '무', '특이사항무', '이상무',
]);

export type IssuesState = 'JUNK' | 'NONE' | 'WRITTEN';

export function classifyIssues(text: string | null | undefined): IssuesState {
  const s = normalizePlanText(text ?? '');
  if (ISSUES_NONE.has(s)) return 'NONE';
  if (s.length < 2) return 'JUNK';
  if (/^(.)\1*$/u.test(s)) return 'JUNK';
  if (/^[ㄱ-ㆎ]+$/u.test(s)) return 'JUNK';
  return 'WRITTEN';
}

/** 고객사명 비교용 정규화 — 공백·구두점·(주)/㈜/주식회사 표기를 없애고 소문자로. */
export function normalizeClientName(name: string): string {
  return (name ?? '')
    .replace(/\(주\)|㈜|주식회사/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .toLowerCase();
}

export function clientNamesMatch(a: string, b: string): boolean {
  const x = normalizeClientName(a);
  const y = normalizeClientName(b);
  if (x.length < 2 || y.length < 2) return false;
  return x.includes(y) || y.includes(x);
}

export function splitClients(visited: string | null | undefined): string[] {
  return (visited ?? '').split(/[,，、/\n]/).map((s) => s.trim()).filter(Boolean);
}

export interface QualityLogInput {
  userId: string;
  userName: string;
  departmentName: string | null;
  dateKey: string; // YYYY-MM-DD
  formType: 'SIMPLE' | 'DETAILED';
  visitedClients: string | null;
  workContent: string | null;
  issues: string;
  tomorrowPlan: string;
  actualEffortMinutes: number | null;
}

export interface QualityAttendanceInput {
  userId: string;
  userName: string;
  departmentName: string | null;
  dateKey: string;
  completed: boolean; // 퇴근까지 마친 날
}

export interface QualityEffortInput {
  userId: string;
  dateKey: string;
  clientName: string;
  minutes: number;
}

export interface LogAssessment {
  userId: string;
  userName: string;
  departmentName: string | null;
  dateKey: string;
  score: number;
  grade: QualityGrade;
  flags: QualityFlag[];
  clientCount: number;
  matchedClientCount: number;
  contentLength: number;
  issues: string;
  workContent: string;
  tomorrowPlan: string;
}

export function gradeOf(score: number): QualityGrade {
  return score >= GOOD_SCORE ? 'GOOD' : score >= FAIR_SCORE ? 'FAIR' : 'POOR';
}

/** 일지 1건 평가. previousSame은 같은 직원의 바로 이전 일지와 작업내용+내일계획이 같은지. */
export function assessLog(
  log: QualityLogInput,
  efforts: QualityEffortInput[],
  registeredClients: string[],
  previousSame: boolean
): LogAssessment {
  const flags: QualityFlag[] = [];
  const content = (log.workContent ?? '').trim();
  const contentLen = normalizePlanText(content).length;
  const effortMinutes = efforts.reduce((sum, e) => sum + Math.max(0, e.minutes), 0);
  const workedAtClient = effortMinutes >= MIN_EFFORT_MINUTES;
  const contentRequired = log.formType === 'DETAILED' || workedAtClient;

  if (!isMeaningfulPlan(log.tomorrowPlan)) flags.push('PLAN_WEAK');
  if (classifyIssues(log.issues) === 'JUNK') flags.push('ISSUES_JUNK');
  if (contentRequired) {
    if (contentLen === 0) flags.push('CONTENT_MISSING');
    else if (contentLen < MIN_CONTENT_LENGTH) flags.push('CONTENT_SHORT');
  }

  // 공수 일치 — 작업 기록의 고객사가 일지(방문 고객사 + 작업내용)에 하나라도 나오는지.
  const visited = splitClients(log.visitedClients);
  const text = `${log.visitedClients ?? ''} ${content}`;
  const effortClients = [...new Set(efforts.filter((e) => e.minutes > 0).map((e) => e.clientName.trim()).filter(Boolean))];
  if (workedAtClient && effortClients.length > 0) {
    const mentioned = effortClients.some((c) => clientNamesMatch(text, c) || visited.some((v) => clientNamesMatch(v, c)));
    if (!mentioned) flags.push('CLIENT_NOT_IN_LOG');
  }
  if (visited.length > 0 && effortClients.length === 0) flags.push('VISIT_WITHOUT_EFFORT');

  // 활용 가능성 — 방문지가 등록 고객사와 매칭되는가.
  const matchedClientCount = visited.filter((v) => registeredClients.some((c) => clientNamesMatch(v, c))).length;
  if (visited.length > 0 && matchedClientCount < visited.length) flags.push('CLIENT_UNREGISTERED');

  if (previousSame) flags.push('COPY_OF_PREVIOUS');

  if (log.actualEffortMinutes != null && Math.abs(log.actualEffortMinutes - effortMinutes) > EFFORT_DIFF_MINUTES) {
    flags.push('EFFORT_SNAPSHOT_DIFF');
  }

  const score = Math.max(0, 100 - flags.reduce((sum, f) => sum + PENALTY[f], 0));
  return {
    userId: log.userId, userName: log.userName, departmentName: log.departmentName, dateKey: log.dateKey,
    score, grade: gradeOf(score), flags,
    clientCount: visited.length, matchedClientCount, contentLength: contentLen,
    issues: log.issues, workContent: content, tomorrowPlan: log.tomorrowPlan,
  };
}

export interface UserQuality {
  userName: string;
  departmentName: string | null;
  completedDays: number;
  logDays: number;
  coverageRate: number | null;
  avgScore: number | null;
  good: number;
  fair: number;
  poor: number;
  topFlags: { flag: QualityFlag; label: string; count: number }[];
  missingDates: string[];
}

export interface QualitySummary {
  totals: {
    userCount: number;
    completedDays: number;
    logDays: number;
    coverageRate: number | null;
    good: number;
    fair: number;
    poor: number;
    usableRate: number | null;
    avgScore: number | null;
    clientMatchRate: number | null;
    avgContentLength: number | null;
  };
  byFlag: { flag: QualityFlag; label: string; count: number; userCount: number }[];
  users: UserQuality[];
  departments: { name: string; userCount: number; completedDays: number; logDays: number; coverageRate: number | null; avgScore: number | null }[];
  daily: { date: string; completedDays: number; logDays: number; avgScore: number | null }[];
  samples: (Pick<LogAssessment, 'userName' | 'dateKey' | 'score' | 'grade' | 'flags' | 'issues' | 'workContent' | 'tomorrowPlan'>)[];
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const avg = (sum: number, n: number): number | null => (n > 0 ? Math.round((sum / n) * 10) / 10 : null);
const excerpt = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export function analyzeWorkLogs(
  logs: QualityLogInput[],
  attendance: QualityAttendanceInput[],
  efforts: QualityEffortInput[],
  registeredClients: string[]
): QualitySummary {
  const effortByKey = new Map<string, QualityEffortInput[]>();
  for (const e of efforts) {
    const k = `${e.userId}|${e.dateKey}`;
    (effortByKey.get(k) ?? effortByKey.set(k, []).get(k)!).push(e);
  }

  // 같은 직원의 일지를 날짜순으로 보며 직전 일지와의 동일 여부를 본다.
  const sorted = [...logs].sort((a, b) => (a.userId === b.userId ? a.dateKey.localeCompare(b.dateKey) : a.userId.localeCompare(b.userId)));
  const assessments: LogAssessment[] = [];
  let prev: QualityLogInput | null = null;
  for (const log of sorted) {
    let same = false;
    if (prev && prev.userId === log.userId) {
      const c = normalizePlanText(log.workContent ?? '');
      const p = normalizePlanText(log.tomorrowPlan);
      same =
        (c.length >= MIN_CONTENT_LENGTH || p.length >= 6) &&
        c === normalizePlanText(prev.workContent ?? '') &&
        p === normalizePlanText(prev.tomorrowPlan);
    }
    assessments.push(assessLog(log, effortByKey.get(`${log.userId}|${log.dateKey}`) ?? [], registeredClients, same));
    prev = log;
  }

  const logKeys = new Set(logs.map((l) => `${l.userId}|${l.dateKey}`));
  const completed = attendance.filter((a) => a.completed);

  // 사용자별
  type Acc = { name: string; dept: string | null; completed: number; logs: number; scoreSum: number; good: number; fair: number; poor: number; flags: Map<QualityFlag, number>; missing: string[] };
  const byUser = new Map<string, Acc>();
  const touch = (userId: string, name: string, dept: string | null): Acc => {
    let a = byUser.get(userId);
    if (!a) { a = { name, dept, completed: 0, logs: 0, scoreSum: 0, good: 0, fair: 0, poor: 0, flags: new Map(), missing: [] }; byUser.set(userId, a); }
    return a;
  };
  for (const a of completed) {
    const u = touch(a.userId, a.userName, a.departmentName);
    u.completed += 1;
    if (logKeys.has(`${a.userId}|${a.dateKey}`)) u.logs += 1;
    else u.missing.push(a.dateKey);
  }
  for (const as of assessments) {
    const u = touch(as.userId, as.userName, as.departmentName);
    // 퇴근 기록 없이 일지만 있는 날(정정 등)도 평가는 한다 — 작성률 분모에는 포함하지 않는다.
    u.scoreSum += as.score;
    if (as.grade === 'GOOD') u.good += 1; else if (as.grade === 'FAIR') u.fair += 1; else u.poor += 1;
    for (const f of as.flags) u.flags.set(f, (u.flags.get(f) ?? 0) + 1);
  }

  const flagCount = new Map<QualityFlag, { count: number; users: Set<string> }>();
  for (const as of assessments) {
    for (const f of as.flags) {
      const cur = flagCount.get(f) ?? { count: 0, users: new Set<string>() };
      cur.count += 1; cur.users.add(as.userId);
      flagCount.set(f, cur);
    }
  }

  const users: UserQuality[] = [...byUser.values()].map((u) => {
    const judged = u.good + u.fair + u.poor;
    return {
      userName: u.name, departmentName: u.dept, completedDays: u.completed, logDays: u.logs,
      coverageRate: rate(u.logs, u.completed), avgScore: avg(u.scoreSum, judged),
      good: u.good, fair: u.fair, poor: u.poor,
      topFlags: [...u.flags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([flag, count]) => ({ flag, label: QUALITY_FLAG_LABELS[flag], count })),
      missingDates: u.missing.sort().slice(-5),
    };
  }).sort((a, b) => {
    // 문제가 큰 사람이 위로: 미작성일 많은 순 → 평균 점수 낮은 순
    const am = a.completedDays - a.logDays; const bm = b.completedDays - b.logDays;
    if (am !== bm) return bm - am;
    return (a.avgScore ?? 101) - (b.avgScore ?? 101);
  });

  // 부서별
  const byDept = new Map<string, { users: Set<string>; completed: number; logs: number; scoreSum: number; judged: number }>();
  for (const [userId, u] of byUser) {
    const key = u.dept ?? '(부서 없음)';
    const d = byDept.get(key) ?? { users: new Set<string>(), completed: 0, logs: 0, scoreSum: 0, judged: 0 };
    d.users.add(userId); d.completed += u.completed; d.logs += u.logs; d.scoreSum += u.scoreSum; d.judged += u.good + u.fair + u.poor;
    byDept.set(key, d);
  }
  const departments = [...byDept.entries()].map(([name, d]) => ({
    name, userCount: d.users.size, completedDays: d.completed, logDays: d.logs, coverageRate: rate(d.logs, d.completed), avgScore: avg(d.scoreSum, d.judged),
  })).sort((a, b) => (a.coverageRate ?? 101) - (b.coverageRate ?? 101));

  // 일자별
  const byDate = new Map<string, { completed: number; logs: number; scoreSum: number; judged: number }>();
  for (const a of completed) {
    const d = byDate.get(a.dateKey) ?? { completed: 0, logs: 0, scoreSum: 0, judged: 0 };
    d.completed += 1;
    if (logKeys.has(`${a.userId}|${a.dateKey}`)) d.logs += 1;
    byDate.set(a.dateKey, d);
  }
  for (const as of assessments) {
    const d = byDate.get(as.dateKey) ?? { completed: 0, logs: 0, scoreSum: 0, judged: 0 };
    d.scoreSum += as.score; d.judged += 1;
    byDate.set(as.dateKey, d);
  }
  const daily = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({
    date, completedDays: d.completed, logDays: d.logs, avgScore: avg(d.scoreSum, d.judged),
  }));

  const good = assessments.filter((a) => a.grade === 'GOOD').length;
  const fair = assessments.filter((a) => a.grade === 'FAIR').length;
  const poor = assessments.filter((a) => a.grade === 'POOR').length;
  const clientTotal = assessments.reduce((s, a) => s + a.clientCount, 0);
  const clientMatched = assessments.reduce((s, a) => s + a.matchedClientCount, 0);
  const completedWithLog = completed.filter((a) => logKeys.has(`${a.userId}|${a.dateKey}`)).length;

  return {
    totals: {
      userCount: byUser.size,
      completedDays: completed.length,
      logDays: completedWithLog,
      coverageRate: rate(completedWithLog, completed.length),
      good, fair, poor,
      usableRate: rate(good, assessments.length),
      avgScore: avg(assessments.reduce((s, a) => s + a.score, 0), assessments.length),
      clientMatchRate: rate(clientMatched, clientTotal),
      avgContentLength: avg(assessments.reduce((s, a) => s + a.contentLength, 0), assessments.length),
    },
    byFlag: [...flagCount.entries()].map(([flag, v]) => ({ flag, label: QUALITY_FLAG_LABELS[flag], count: v.count, userCount: v.users.size })).sort((a, b) => b.count - a.count),
    users,
    departments,
    daily,
    samples: assessments
      .filter((a) => a.grade !== 'GOOD')
      .sort((a, b) => a.score - b.score || b.dateKey.localeCompare(a.dateKey))
      .slice(0, 30)
      .map((a) => ({
        userName: a.userName, dateKey: a.dateKey, score: a.score, grade: a.grade, flags: a.flags,
        issues: excerpt(a.issues), workContent: excerpt(a.workContent), tomorrowPlan: excerpt(a.tomorrowPlan),
      })),
  };
}
