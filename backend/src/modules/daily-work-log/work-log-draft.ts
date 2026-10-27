/**
 * 2026-10-15: 업무일지 자동초안 개선(순수 함수) — "당일 엔지니어가 입력한 기록을 토대로 기본 틀을 잡아주고, 직원이 고쳐서 마무리"한다.
 *  1) formatWorkContent : 오늘 작업 기록(EffortLog)·야간/주말 메일보고를 고객사별 표준 형식으로 정리한다.
 *  2) buildSuggestions  : 이슈/특이사항 · 후속조치 · 내일 예정 업무의 "제안 문구"(칩)를 만든다.
 * 규칙 기반이며 외부 AI를 쓰지 않는다(일지 내용이 외부로 나가지 않음). 제안은 직원이 눌러서 넣고 고쳐 쓰는 용도이고,
 * 서버가 대신 저장하지 않는다 — 최종 내용은 직원이 확인한 값만 제출된다.
 */

export interface DraftEffort {
  clientName: string | null;
  projectName: string | null;
  workType: string | null;
  startTime: Date;
  endTime: Date | null;
  minutes: number | null;
  actualMinutes: number | null;
  description: string | null;
  contactName: string | null;
  taskId: string | null;
}

export interface DraftMailReport {
  kind: 'NIGHT' | 'WEEKEND' | string;
  clientNameRaw: string | null;
  workContent: string | null;
}

export interface DraftOpenTask {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | string;
  dueDate: Date | null;
  projectName: string;
}

export interface Suggestion {
  text: string;
  reason: string;
}

export interface DraftSuggestions {
  issues: Suggestion[];
  followUp: Suggestion[];
  tomorrowPlan: Suggestion[];
}

export const MAX_SUGGESTIONS = 5;

function kst(d: Date): Date {
  return new Date(d.getTime() + 9 * 3600_000);
}

export function hhmm(d: Date): string {
  const k = kst(d);
  return `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

export function mmdd(d: Date): string {
  const k = kst(d);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()}`;
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}시간 ${m}분`;
  if (h > 0) return `${h}시간`;
  return `${m}분`;
}

function effortMinutes(e: DraftEffort): number {
  return Math.max(0, e.actualMinutes ?? e.minutes ?? 0);
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export function isIncidentWork(workType: string | null | undefined): boolean {
  return clean(workType).includes('장애');
}

/**
 * 작업내용 표준 형식 — 고객사별로 묶고, 시간순으로 "시간 (소요) 작업유형 · 담당" + "→ 직원이 적은 설명".
 * 설명이 비어 있는 항목은 빈 칸으로 두고(자리표시 문구를 저장하지 않는다) 개수만 알려준다.
 */
export function formatWorkContent(
  efforts: DraftEffort[],
  mailReports: DraftMailReport[]
): { text: string | null; missingDescriptionCount: number } {
  const sorted = [...efforts].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const groups = new Map<string, DraftEffort[]>();
  for (const e of sorted) {
    const key = [clean(e.clientName), clean(e.projectName)].filter(Boolean).join(' · ') || '작업';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const lines: string[] = [];
  let missing = 0;
  for (const [label, items] of groups) {
    lines.push(`■ ${label}`);
    for (const e of items) {
      const time = e.endTime ? `${hhmm(e.startTime)}~${hhmm(e.endTime)}` : `${hhmm(e.startTime)}~진행중`;
      const mins = e.endTime ? effortMinutes(e) : 0;
      const parts = [`${time}${mins > 0 ? ` (${durationLabel(mins)})` : ''}`];
      const type = clean(e.workType);
      if (type) parts.push(type);
      const contact = clean(e.contactName);
      if (contact) parts.push(`담당 ${contact}`);
      lines.push(`- ${parts.join(' · ')}`);
      const desc = clean(e.description);
      if (desc) lines.push(`  → ${desc}`);
      else missing += 1;
    }
  }
  for (const m of mailReports) {
    const body = clean(m.workContent);
    lines.push(`■ ${clean(m.clientNameRaw) || '고객사 미기재'} (${m.kind === 'NIGHT' ? '야간작업' : '주말작업'} 메일보고)`);
    if (body) lines.push(`  → ${body}`);
  }
  return { text: lines.length > 0 ? lines.join('\n') : null, missingDescriptionCount: missing };
}

function pushUnique(list: Suggestion[], s: Suggestion): void {
  const key = s.text.replace(/\s+/g, '');
  if (!list.some((x) => x.text.replace(/\s+/g, '') === key)) list.push(s);
}

/** 제안 문구 — 오늘 작업 기록 + 진행 중인 작업 + 본인에게 배정된 미완료 Task만 근거로 한다. */
export function buildSuggestions(efforts: DraftEffort[], openTasks: DraftOpenTask[]): DraftSuggestions {
  const issues: Suggestion[] = [];
  const followUp: Suggestion[] = [];
  const plan: Suggestion[] = [];

  const sorted = [...efforts].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const incidents = sorted.filter((e) => isIncidentWork(e.workType));

  // 이슈/특이사항 — 장애대응을 한 날은 그 건을, 아니면 "특이사항 없음" 한 줄을 제안한다.
  for (const e of incidents) {
    const client = clean(e.clientName) || '고객사';
    pushUnique(issues, {
      text: `${client} 장애대응(${hhmm(e.startTime)}) 처리 — 원인/조치: `,
      reason: '오늘 장애대응 작업 기록이 있어요',
    });
  }
  if (incidents.length === 0) {
    pushUnique(issues, { text: '특이사항 없음', reason: '오늘 장애대응 기록이 없어요' });
  }

  // 후속조치 — 장애대응 후 모니터링, 종료하지 않은 작업의 마무리.
  for (const e of incidents) {
    const client = clean(e.clientName) || '고객사';
    pushUnique(followUp, { text: `${client} 장애 처리 후 재발 여부 모니터링`, reason: '장애대응 작업 후속' });
  }
  const openEfforts = sorted.filter((e) => e.endTime == null);
  for (const e of openEfforts) {
    const client = clean(e.clientName) || '고객사';
    const type = clean(e.workType) || '작업';
    pushUnique(followUp, { text: `${client} ${type} 잔여 작업 마무리 필요`, reason: '종료 등록하지 않은 작업이에요' });
  }

  // 내일 예정 업무 — ① 진행중(미종료) 작업 ② 오늘 작업한 Task ③ 배정된 진행중 Task ④ 기한 임박 순 TODO.
  for (const e of openEfforts) {
    const client = clean(e.clientName) || '고객사';
    const project = clean(e.projectName);
    const type = clean(e.workType) || '작업';
    pushUnique(plan, { text: `${client}${project ? ` ${project}` : ''} ${type} 이어서 진행`, reason: '종료하지 않은 작업이에요' });
  }
  const workedTaskIds = new Set(efforts.map((e) => e.taskId).filter((x): x is string => !!x));
  const statusRank = (t: DraftOpenTask): number => (workedTaskIds.has(t.id) ? 0 : t.status === 'IN_PROGRESS' ? 1 : 2);
  const tasks = openTasks
    .filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS')
    .sort((a, b) => {
      const r = statusRank(a) - statusRank(b);
      if (r !== 0) return r;
      const ad = a.dueDate ? a.dueDate.getTime() : Number.MAX_SAFE_INTEGER;
      const bd = b.dueDate ? b.dueDate.getTime() : Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });
  for (const t of tasks) {
    const due = t.dueDate ? ` (기한 ${mmdd(t.dueDate)})` : '';
    const reason = workedTaskIds.has(t.id) ? '오늘 작업한 Task예요' : t.status === 'IN_PROGRESS' ? '내게 배정된 진행중 Task예요' : '내게 배정된 Task예요';
    pushUnique(plan, { text: `${t.projectName} · ${t.title}${due} 진행`, reason });
  }

  return {
    issues: issues.slice(0, MAX_SUGGESTIONS),
    followUp: followUp.slice(0, MAX_SUGGESTIONS),
    tomorrowPlan: plan.slice(0, MAX_SUGGESTIONS),
  };
}
