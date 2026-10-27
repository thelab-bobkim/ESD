import { createRouter } from '../../common/async-router';
import { takeWithTruncation, setTruncationHeaders } from '../../common/list-limit';

const DAILY_WORK_LOG_LIST_LIMIT = 1000;
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { resolveWorkDateForUser, todayDateOnly, realDayWindow } from '../../common/attendance-helpers';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';
import { isMeaningfulPlan, PLAN_RULE_MESSAGE } from './work-log-rules';
import { isAiAssistEnabled, aiModel, aiDailyLimit, aiUsageLimiter, buildPolishRequest, buildVoiceRequest, callClaude, parseAiJson, sanitizeResult, AiError, MAX_FIELD_CHARS, MAX_TRANSCRIPT_CHARS, type AiFields } from './ai-assist';
import { formatWorkContent, buildSuggestions, type DraftEffort, type DraftMailReport, type DraftOpenTask } from './work-log-draft';
import { aiPilotDepts } from './ai-assist';

/** AI 보조를 이 직원에게 열어도 되는지 — 기능이 켜져 있고, 시범 팀 제한이 있으면 그 팀 소속일 때만 true. */
async function isAiAllowedForUser(userId: string): Promise<boolean> {
  if (!isAiAssistEnabled()) return false;
  const depts = aiPilotDepts();
  if (depts.length === 0) return true;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { department: { select: { name: true } } } });
  const name = u?.department?.name;
  return !!name && depts.includes(name);
}

/**
 * 일일업무일지 모듈 (2026-09-26, 김형태 대표이사 요청 — "매일 업무 마감을 일일업무일지로").
 *
 * 3단계 로드맵을 이 모듈 하나로 지원한다:
 *  1단계(강제 마감): POST /   — 퇴근 시 attendance.routes.ts가 이 upsert 로직과 동일한 필수값
 *                    검증(이슈/특이사항 + 내일 예정 업무)을 거쳐 함께 호출한다.
 *  2단계(자동초안): GET /draft — StatusChangeLog/EffortLog/NightWorkMailReport에서 오늘치를
 *                    모아 9개 표준 필드를 미리 채워준다. 프론트(ClockOutConfirmModal)가 퇴근
 *                    확인창을 띄우기 전에 먼저 호출해서 간단형/상세형을 결정하고 초안을 보여준다.
 *  3단계(관리자 열람): GET /admin/list, GET /admin/summary — night-work-mail 관리자 화면과
 *                    같은 패턴(목록 + 집계)으로 제공한다.
 */
export const dailyWorkLogRouter = createRouter();

// 이 상태로 하루를 보낸 날은 기록할 내용이 많다고 보고 "상세형"으로 자동 분류한다(2단계 판단
// 기준) — 고객사/현장/야간·주말 근무가 여기 해당한다. 나머지(본사근무/재택/휴가/대체휴무 등)는
// "간단형"으로, 이슈/특이사항 + 내일 예정 업무 두 줄이면 충분하다고 본다.
const DETAILED_STATUSES = new Set([
  'CLIENT_WORK', 'CLIENT_MEETING', 'BUSINESS_TRIP', 'RESIDENT_ONSITE', 'NIGHT_WORK', 'WEEKEND_WORK',
]);

const STATUS_LABELS: Record<string, string> = {
  REMOTE: '재택(집)',
  HQ_WORKING: '본사근무',
  RESIDENT_ONSITE: '고객사상주',
  OFFSITE: '외근',
  MOVING: '이동중',
  MEETING: '미팅',
  CLIENT_MEETING: '고객사미팅',
  CLIENT_WORK: '고객사작업',
  NIGHT_WORK: '야간작업',
  WEEKEND_WORK: '주말작업',
  BUSINESS_TRIP: '출장',
  ALT_DAY_OFF: '대체휴무',
  ON_LEAVE: '휴가',
};

function hhmmLabel(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

/** "2026-09-26" 형식의 query string을 workDate(UTC 자정 Date)로 해석한다. 없거나 형식이 틀리면 오늘. */
function parseWorkDateParam(raw: unknown): Date {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00.000Z`);
  }
  return todayDateOnly();
}

/**
 * "미등록 공백시간" 판정 (2026-09-29, 김형태 대표이사 요청).
 * 예: 최문석님 사례 — 고객사작업을 10:03에 등록하고 16:00 완료로 마감했는데, 그 뒤로 아무 상태도
 * 새로 등록하지 않은 채 19:10에 퇴근을 누르면 16:00~19:10(3시간10분)이 "뭘 했는지 기록이 없는데
 * 근무시간으로는 그대로 잡히는" 공백이 된다. 근로시간(급여) 계산 자체는 건드리지 않기로 했으므로
 * (2026-09-29 결정), 이 함수는 공백을 "감지"만 하고 — 감지되면 호출하는 쪽(POST /clock-out,
 * GET /draft)이 사유 입력을 요구한다.
 *
 * 판정 기준: 오늘 "종료시간이 찍힌" EffortLog 중 가장 늦은 것(latestFinishedEffort) 이후에,
 * 새로 등록된 상태변경(StatusChangeLog)이 하나도 없어야 한다 — 즉 "그 다음에 뭘 했는지"를
 * 본인이 이미 알려준 경우(예: 고객사작업 끝나고 "이동중"이라도 눌렀으면)는 공백으로 보지 않는다.
 * 본사근무처럼 끝나는 시각이 따로 없는 상태(종료시간 없이 "지금 이 상태"로 계속 유지되는 상태)는
 * 애초에 latestFinishedEffort 후보가 아니므로, 평범한 하루(예: 본사근무만 하다 퇴근)에는 절대
 * 걸리지 않는다.
 */
export async function computeUnloggedGapMinutes(
  userId: string,
  workDate: Date,
  asOf: Date
): Promise<{ minutes: number; sinceISO: string } | null> {
  const { start, end } = realDayWindow(workDate);
  const [latestStatus, latestFinishedEffort] = await Promise.all([
    prisma.statusChangeLog.findFirst({ where: { userId, changedAt: { gte: start, lt: end } }, orderBy: { changedAt: 'desc' } }),
    prisma.effortLog.findFirst({ where: { userId, workDate, endTime: { not: null } }, orderBy: { endTime: 'desc' } }),
  ]);
  if (!latestFinishedEffort?.endTime) return null;
  // 마지막 완료 이후에 뭔가 더 등록했으면(이동중 등) 공백이 아니다.
  if (latestStatus && latestStatus.changedAt > latestFinishedEffort.endTime) return null;
  // 2026-09-29: 임계값을 기존 GPS 위치이탈 자동감지(고객사작업 이탈 후 DEPARTURE_AWAY_THRESHOLD_MS,
  // frontend/pages/index.tsx)와 동일하게 30분으로 맞춘다(대표이사 요청) — 두 메커니즘이 같은
  // "이탈 후 N분" 감각을 공유해야 관리자/직원 모두 헷갈리지 않는다.
  const thresholdMinutes = await getPolicyNumber('UNLOGGED_GAP_WARN_MINUTES', 30);
  const minutes = Math.round((asOf.getTime() - latestFinishedEffort.endTime.getTime()) / 60000);
  if (minutes < thresholdMinutes) return null;
  return { minutes, sinceISO: latestFinishedEffort.endTime.toISOString() };
}

/** upsert에 공통으로 쓰는 필드 검증 — 1단계부터 필수인 두 줄(issues/tomorrowPlan)을 여기서 강제한다. */
export const dailyWorkLogInputSchema = z.object({
  workDate: z.string().optional(), // 없으면 오늘(todayDateOnly 기준)
  formType: z.enum(['SIMPLE', 'DETAILED']).optional(),
  workTypeSnapshot: z.string().max(60).optional(),
  visitedClients: z.string().max(500).optional(),
  workContent: z.string().max(4000).optional(),
  // 2026-09-30 수정: upsertDailyWorkLog가 저장 직전에 trim하므로, 공백문자만 보낸 값("   ")은
  // min(1)을 통과해 DB에 빈 문자열로 저장될 수 있었다 — trim 후 검증하도록 바꾼다.
  issues: z.string().trim().min(1, '이슈/특이사항을 입력해주세요.').max(2000),
  followUp: z.string().max(2000).optional(),
  // 2026-10-12: "."/"없음"/"미정" 같은 의미 없는 값을 막는다(work-log-rules.ts). 휴가·반차 등 짧지만 분명한 답은 허용.
  tomorrowPlan: z.string().trim().min(1, '내일 예정 업무를 입력해주세요.').max(2000).refine(isMeaningfulPlan, PLAN_RULE_MESSAGE),
  supportRequest: z.string().max(2000).optional(),
  totalWorkedMinutes: z.number().int().min(0).optional(),
  actualEffortMinutes: z.number().int().min(0).optional(),
  autoDraftSnapshot: z.string().max(6000).optional(),
  // 2026-09-29: "미등록 공백시간" 사유 — computeUnloggedGapMinutes가 공백을 감지했을 때만 채워진다.
  unloggedGapMinutes: z.number().int().min(0).optional(),
  unloggedGapReason: z.string().max(1000).optional(),
});

type DailyWorkLogInput = z.infer<typeof dailyWorkLogInputSchema>;

/** attendance.routes.ts /clock-out에서도 그대로 재사용하는 upsert 로직 — workDate/userId 기준 하루 1건. */
export async function upsertDailyWorkLog(userId: string, workDate: Date, input: DailyWorkLogInput) {
  const issues = input.issues.trim();
  const tomorrowPlan = input.tomorrowPlan.trim();
  return prisma.dailyWorkLog.upsert({
    where: { userId_workDate: { userId, workDate } },
    create: {
      userId,
      workDate,
      formType: input.formType ?? 'SIMPLE',
      workTypeSnapshot: input.workTypeSnapshot,
      visitedClients: input.visitedClients,
      workContent: input.workContent,
      issues,
      followUp: input.followUp,
      tomorrowPlan,
      supportRequest: input.supportRequest,
      totalWorkedMinutes: input.totalWorkedMinutes,
      actualEffortMinutes: input.actualEffortMinutes,
      autoDraftSnapshot: input.autoDraftSnapshot,
      unloggedGapMinutes: input.unloggedGapMinutes,
      unloggedGapReason: input.unloggedGapReason,
    },
    update: {
      formType: input.formType ?? 'SIMPLE',
      workTypeSnapshot: input.workTypeSnapshot,
      visitedClients: input.visitedClients,
      workContent: input.workContent,
      issues,
      followUp: input.followUp,
      tomorrowPlan,
      supportRequest: input.supportRequest,
      ...(input.totalWorkedMinutes != null ? { totalWorkedMinutes: input.totalWorkedMinutes } : {}),
      ...(input.actualEffortMinutes != null ? { actualEffortMinutes: input.actualEffortMinutes } : {}),
      // 공백이 이번엔 없으면(사유 미첨부) 예전 공백 기록을 지운다 — 재정정 등으로 다시 계산됐을 때
      // 낡은 공백 표시가 관리자 화면에 남아있지 않도록.
      unloggedGapMinutes: input.unloggedGapMinutes ?? null,
      unloggedGapReason: input.unloggedGapReason ?? null,
    },
  });
}

dailyWorkLogRouter.use(requireAuth);

/** 2단계: 오늘치 자동초안 — StatusChangeLog/EffortLog/NightWorkMailReport를 모아 9개 표준 필드를 채워준다. */
dailyWorkLogRouter.get('/draft', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = typeof req.query.workDate === 'string' && req.query.workDate ? parseWorkDateParam(req.query.workDate) : await resolveWorkDateForUser(userId);
  const { start, end } = realDayWindow(workDate);

  const [statuses, effortLogs, attendanceRecord, existing, me, unloggedGap, openTaskRows] = await Promise.all([
    prisma.statusChangeLog.findMany({ where: { userId, changedAt: { gte: start, lt: end } }, orderBy: { changedAt: 'asc' } }),
    prisma.effortLog.findMany({ where: { userId, workDate }, orderBy: { startTime: 'asc' } }),
    prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } }),
    prisma.dailyWorkLog.findUnique({ where: { userId_workDate: { userId, workDate } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    // 퇴근 전에 미리 보여주기 위한 "지금 시점 기준" 공백 판정 — 실제 퇴근 시점엔 attendance.routes.ts
    // /clock-out이 그때의 clockOutAt 기준으로 다시 한번 독립적으로 계산해서 최종 검증한다.
    computeUnloggedGapMinutes(userId, workDate, new Date()),
    // 2026-10-15: "내일 예정 업무" 제안 근거 — 나에게 배정된 미완료 Task(진행중 먼저, 기한 임박 순은 buildSuggestions가 정렬).
    prisma.projectTask.findMany({
      where: { assigneeId: userId, status: { in: ['TODO', 'IN_PROGRESS'] }, project: { status: { in: ['PLANNED', 'ACTIVE'] } } },
      orderBy: [{ dueDate: 'asc' }],
      take: 20,
      select: { id: true, title: true, status: true, dueDate: true, project: { select: { name: true } } },
    }),
  ]);

  const mailReports = me?.email
    ? await prisma.nightWorkMailReport.findMany({ where: { reporterEmail: me.email, workDate } })
    : [];

  const statusSet = new Set(statuses.map((s) => s.status as string));
  const formType: 'SIMPLE' | 'DETAILED' = [...statusSet].some((s) => DETAILED_STATUSES.has(s)) ? 'DETAILED' : 'SIMPLE';

  const visitedClientsSet = new Set<string>();
  effortLogs.forEach((e) => { if (e.clientName) visitedClientsSet.add(e.clientName); });
  mailReports.forEach((m) => { if (m.clientNameRaw) visitedClientsSet.add(m.clientNameRaw); });

  // 2026-10-15: 작업내용을 고객사별 표준 형식으로 정리하고, 이슈/후속조치/내일 예정 업무 제안(칩)을 함께 내려준다(work-log-draft.ts).
  const draftEfforts: DraftEffort[] = effortLogs.map((e) => ({
    clientName: e.clientName, projectName: e.projectName, workType: e.workType, startTime: e.startTime, endTime: e.endTime,
    minutes: e.minutes, actualMinutes: e.actualMinutes, description: e.description, contactName: e.contactName, taskId: e.taskId,
  }));
  const draftMails: DraftMailReport[] = mailReports.map((m) => ({ kind: m.kind, clientNameRaw: m.clientNameRaw, workContent: m.workContent }));
  const openTasks: DraftOpenTask[] = (openTaskRows as any[]).map((t) => ({
    id: t.id, title: t.title, status: t.status, dueDate: t.dueDate, projectName: t.project?.name ?? '',
  }));
  const formatted = formatWorkContent(draftEfforts, draftMails);
  const suggestions = buildSuggestions(draftEfforts, openTasks);

  const actualEffortMinutes = effortLogs.reduce((sum, e) => sum + (e.actualMinutes ?? e.minutes ?? 0), 0);
  const lastStatus = statuses[statuses.length - 1];

  // 2026-10-21: 이어쓰기 도우미 — 본인의 과거 기록만으로 만든 안내(외부 전송 없음, 다른 직원 기록은 사용하지 않는다).
  const FRIDAY_PLAN_PLACEHOLDER = '금요일 마감 (주말 휴무)';
  const dayStr = (d: Date) => d.toISOString().slice(0, 10);
  const todayClients = [...visitedClientsSet];
  const [recentLogs, pastEfforts] = await Promise.all([
    prisma.dailyWorkLog.findMany({
      where: { userId, workDate: { lt: workDate, gte: new Date(workDate.getTime() - 14 * 24 * 60 * 60 * 1000) } },
      orderBy: { workDate: 'desc' },
      take: 14,
      select: { workDate: true, tomorrowPlan: true, followUp: true, visitedClients: true },
    }),
    todayClients.length
      ? prisma.effortLog.findMany({
          where: { userId, workDate: { lt: workDate }, clientName: { in: todayClients } },
          orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
          take: 40,
          select: { workDate: true, clientName: true, workType: true, description: true },
        })
      : Promise.resolve([] as { workDate: Date; clientName: string; workType: string; description: string | null }[]),
  ]);
  const prevLog = recentLogs[0];
  const previousPlan =
    prevLog &&
    workDate.getTime() - prevLog.workDate.getTime() <= 4 * 24 * 60 * 60 * 1000 &&
    prevLog.tomorrowPlan &&
    prevLog.tomorrowPlan.trim() !== FRIDAY_PLAN_PLACEHOLDER &&
    isMeaningfulPlan(prevLog.tomorrowPlan)
      ? { workDate: dayStr(prevLog.workDate), text: prevLog.tomorrowPlan.trim() }
      : null;
  const clientSet = new Set(todayClients);
  const followUps = recentLogs
    .filter((l) => l.followUp && isMeaningfulPlan(l.followUp))
    .map((l) => ({
      workDate: dayStr(l.workDate),
      text: l.followUp!.trim().slice(0, 200),
      sameClient: (l.visitedClients ?? '').split(',').map((s) => s.trim()).some((c) => c && clientSet.has(c)),
    }))
    .sort((a, b) => Number(b.sameClient) - Number(a.sameClient))
    .slice(0, 3);
  const lastVisits: { clientName: string; workDate: string; workType: string; description: string }[] = [];
  const seenClients = new Set<string>();
  for (const e of pastEfforts) {
    if (seenClients.has(e.clientName)) continue;
    seenClients.add(e.clientName);
    lastVisits.push({ clientName: e.clientName, workDate: dayStr(e.workDate), workType: e.workType, description: (e.description ?? '').trim().slice(0, 150) });
    if (lastVisits.length >= 5) break;
  }
  const history = { previousPlan, followUps, lastVisits };

  return res.json({
    success: true,
    data: {
      workDate: workDate.toISOString().slice(0, 10),
      formType,
      workTypeSnapshot: lastStatus ? (STATUS_LABELS[lastStatus.status] ?? lastStatus.status) : null,
      visitedClients: [...visitedClientsSet].join(', ') || null,
      workContent: formatted.text,
      // 작업 설명(description)이 비어 있는 작업 기록 수 — 화면에서 "설명을 적어주세요" 안내에 쓴다.
      missingDescriptionCount: formatted.missingDescriptionCount,
      // 이슈/후속조치/내일 예정 업무 제안 문구(직원이 눌러서 넣고 고쳐 쓴다 — 서버가 대신 저장하지 않는다).
      suggestions,
      // 2026-10-15: AI 보조(문장 다듬기·말/메모로 채우기) 사용 가능 여부 — 꺼져 있으면 화면에 버튼이 나오지 않는다.
      aiAssistEnabled: await isAiAllowedForUser(req.authUser!.userId),
      history,
      totalWorkedMinutes: attendanceRecord?.totalWorkedMinutes ?? null,
      actualEffortMinutes: actualEffortMinutes || null,
      // 미등록 공백시간 — 있으면 프론트가 퇴근 전에 미리 사유 입력창을 보여준다.
      unloggedGap,
      // 이미 오늘치를 제출한 적이 있으면(퇴근 정정 등으로 다시 여는 경우) 자동초안 대신 기존
      // 제출값을 우선 보여준다 — 자동초안으로 덮어써서 이미 고쳐둔 내용을 잃어버리지 않게.
      existing: existing
        ? {
            formType: existing.formType,
            workTypeSnapshot: existing.workTypeSnapshot,
            visitedClients: existing.visitedClients,
            workContent: existing.workContent,
            issues: existing.issues,
            followUp: existing.followUp,
            tomorrowPlan: existing.tomorrowPlan,
            supportRequest: existing.supportRequest,
            unloggedGapReason: existing.unloggedGapReason,
          }
        : null,
    },
  });
});

/** 본인의 특정 날짜 일지 조회(기본 오늘) — 이미 제출됐는지 확인하는 용도. */
dailyWorkLogRouter.get('/me', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = parseWorkDateParam(req.query.workDate);
  const row = await prisma.dailyWorkLog.findUnique({ where: { userId_workDate: { userId, workDate } } });
  return res.json({ success: true, data: row });
});

const aiAssistSchema = z.object({
  mode: z.enum(['polish', 'voice']),
  issues: z.string().max(MAX_FIELD_CHARS).optional(),
  followUp: z.string().max(MAX_FIELD_CHARS).optional(),
  tomorrowPlan: z.string().max(MAX_FIELD_CHARS).optional(),
  transcript: z.string().max(MAX_TRANSCRIPT_CHARS).optional(),
});

/**
 * 2026-10-15: 업무일지 AI 보조 — mode=polish(적은 문장 다듬기) / mode=voice(말·메모를 이슈/후속조치/내일 예정으로 나눠 정리).
 * 결과는 저장하지 않고 "제안"으로만 돌려준다(직원이 확인·적용해야 입력칸에 들어감). 기본 꺼짐(ai-assist.ts 참고).
 */
dailyWorkLogRouter.post('/ai-assist', async (req, res) => {
  if (!(await isAiAllowedForUser(req.authUser!.userId))) {
    return res.status(503).json({ success: false, error: { code: 'AI_DISABLED', message: 'AI 보조 기능이 아직 켜져 있지 않아요. 직접 입력해주세요.' } });
  }
  const parsed = aiAssistSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력 내용을 확인하세요.' } });
  }
  const { mode, transcript, ...fields } = parsed.data;
  const original: AiFields = { issues: fields.issues ?? '', followUp: fields.followUp ?? '', tomorrowPlan: fields.tomorrowPlan ?? '' };
  const textLen = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').length;
  if (mode === 'polish' && textLen(original.issues) + textLen(original.followUp) + textLen(original.tomorrowPlan) < 2) {
    return res.status(400).json({ success: false, error: { code: 'NOTHING_TO_POLISH', message: '다듬을 내용을 먼저 적어주세요.' } });
  }
  if (mode === 'voice' && textLen(transcript) < 5) {
    return res.status(400).json({ success: false, error: { code: 'NOTHING_TO_POLISH', message: '말하거나 적은 내용이 너무 짧아요.' } });
  }

  const userId = req.authUser!.userId;
  const limited = aiUsageLimiter.check(userId, aiDailyLimit());
  if (limited === 'TOO_FAST') {
    return res.status(429).json({ success: false, error: { code: 'AI_TOO_FAST', message: '잠시 후 다시 눌러주세요.' } });
  }
  if (limited === 'LIMIT') {
    return res.status(429).json({ success: false, error: { code: 'AI_LIMIT', message: '오늘 AI 보조 사용 횟수를 다 썼어요. 직접 입력해주세요.' } });
  }
  aiUsageLimiter.record(userId);

  let request: { system: string; user: string };
  if (mode === 'polish') {
    request = buildPolishRequest(original);
  } else {
    // 오늘 방문 고객사명만 참고로 전달한다(직원 이름·좌표는 보내지 않는다).
    let clients: string[] = [];
    try {
      const rows = await prisma.effortLog.findMany({ where: { userId, workDate: todayDateOnly() }, select: { clientName: true }, take: 30 });
      clients = [...new Set((rows as any[]).map((r) => String(r.clientName ?? '').trim()).filter(Boolean))];
    } catch { /* 참고용이라 실패해도 계속 */ }
    request = buildVoiceRequest(transcript ?? '', clients);
  }

  let ok = false;
  let status: number | undefined;
  try {
    const text = await callClaude({ apiKey: String(process.env.ANTHROPIC_API_KEY), model: aiModel(), system: request.system, user: request.user });
    const result = parseAiJson(text);
    if (!result) throw new AiError('AI_BAD_RESPONSE');
    const suggestions = sanitizeResult(result, mode, mode === 'polish' ? original : { issues: '', followUp: '', tomorrowPlan: '' });
    ok = true;
    return res.json({ success: true, data: { mode, suggestions, changed: Object.keys(suggestions).length } });
  } catch (e) {
    status = e instanceof AiError ? e.httpStatus : undefined;
    const code = e instanceof AiError ? e.code : 'AI_UNAVAILABLE';
    return res.status(502).json({ success: false, error: { code, message: 'AI가 지금 응답하지 못했어요. 직접 입력하셔도 퇴근은 그대로 할 수 있어요.' } });
  } finally {
    // 내용은 남기지 않고 사용 사실(모드·성공 여부)만 감사로그에 남긴다.
    recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'ai_assist', afterValue: { mode, ok, ...(status ? { status } : {}) } }).catch(() => undefined);
  }
});

/** 1단계/2단계 공용 제출 엔드포인트 — 퇴근 흐름 밖에서(정정 등) 직접 저장/수정할 때 쓴다. */
dailyWorkLogRouter.post('/', async (req, res) => {
  const parsed = dailyWorkLogInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' },
    });
  }
  const userId = req.authUser!.userId;
  const workDate = parsed.data.workDate ? parseWorkDateParam(parsed.data.workDate) : await resolveWorkDateForUser(userId);
  const row = await upsertDailyWorkLog(userId, workDate, parsed.data);
  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'daily_work_log', targetId: row.id, afterValue: { workDate: row.workDate, formType: row.formType } });
  return res.json({ success: true, data: row });
});

// 아래부터는 관리자 전용(3단계) — night-work-mail 관리자 화면과 동일한 권한 체계.
const adminRouter = createRouter();
adminRouter.use(requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

const adminQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  formType: z.enum(['SIMPLE', 'DETAILED']).optional(),
  q: z.string().optional(), // 이름/부서/고객사 부분일치 검색
});

function buildAdminWhere(query: z.infer<typeof adminQuerySchema>) {
  const where: Record<string, unknown> = {};
  if (query.from || query.to) {
    where.workDate = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  if (query.formType) where.formType = query.formType;
  if (query.q && query.q.trim()) {
    const term = query.q.trim();
    where.OR = [
      { visitedClients: { contains: term, mode: 'insensitive' } },
      { workContent: { contains: term, mode: 'insensitive' } },
      { user: { name: { contains: term, mode: 'insensitive' } } },
    ];
  }
  return where;
}

/**
 * 위치이탈 자동감지 이벤트 조회 (2026-09-29, 김형태 대표이사 요청).
 * "고객사에서 이탈 후 30분" 자동감지(attendance.routes.ts의 /effort-departure-confirm)가 남긴
 * StatusChangeLog(이동중, note가 '[위치이탈 자동감지]'로 시작)를 조회 대상 (userId, workDate) 범위에
 * 맞춰 한 번에 모아온다 — 업무일지 사유(unloggedGapReason)와는 별개 테이블/별개 정보이므로 관리자
 * 화면에도 별도 블록으로 보여준다. N+1을 피하려고 목록 조회당 한 번만 조회하고, 새벽3시 경계
 * (realDayWindow)를 감안해 각 로그를 해당하는 workDate 행에 매칭한다.
 */
async function attachDepartureEvents<T extends { id: string; userId: string; workDate: Date }>(
  rows: T[]
): Promise<Map<string, Array<{ at: Date; note: string; locationMatch: boolean | null; locationDistanceMeters: number | null }>>> {
  const byId = new Map<string, Array<{ at: Date; note: string; locationMatch: boolean | null; locationDistanceMeters: number | null }>>();
  if (rows.length === 0) return byId;
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const times = rows.map((r) => realDayWindow(r.workDate));
  const start = new Date(Math.min(...times.map((t) => t.start.getTime())));
  const end = new Date(Math.max(...times.map((t) => t.end.getTime())));
  const departureLogs = await prisma.statusChangeLog.findMany({
    where: { userId: { in: userIds }, changedAt: { gte: start, lt: end }, note: { startsWith: '[위치이탈 자동감지]' } },
    orderBy: { changedAt: 'asc' },
  });
  if (departureLogs.length === 0) return byId;
  for (const row of rows) {
    const { start: rs, end: re } = realDayWindow(row.workDate);
    const matched = departureLogs.filter((log) => log.userId === row.userId && log.changedAt >= rs && log.changedAt < re);
    if (matched.length > 0) {
      byId.set(
        row.id,
        matched.map((log) => ({
          at: log.changedAt,
          note: log.note ?? '',
          locationMatch: log.locationMatch,
          locationDistanceMeters: log.locationDistanceMeters,
        }))
      );
    }
  }
  return byId;
}

adminRouter.get('/list', async (req, res) => {
  const parsed = adminQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '조회 조건을 확인하세요.' } });
  }
  const fetched = await prisma.dailyWorkLog.findMany({
    where: buildAdminWhere(parsed.data),
    include: { user: { select: { name: true, employeeNo: true, department: { select: { name: true } } } } },
    orderBy: [{ workDate: 'desc' }, { submittedAt: 'desc' }],
    // 2026-09-30(M-3): 1건 더 조회해 잘림 여부를 판정하고 헤더로 알린다.
    take: DAILY_WORK_LOG_LIST_LIMIT + 1,
  });
  const { rows, truncated } = takeWithTruncation(fetched, DAILY_WORK_LOG_LIST_LIMIT);
  setTruncationHeaders(res, truncated, DAILY_WORK_LOG_LIST_LIMIT);
  const departureById = await attachDepartureEvents(rows);
  return res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      workDate: r.workDate,
      userName: r.user.name,
      employeeNo: r.user.employeeNo,
      departmentName: r.user.department?.name ?? null,
      formType: r.formType,
      workTypeSnapshot: r.workTypeSnapshot,
      visitedClients: r.visitedClients,
      workContent: r.workContent,
      issues: r.issues,
      followUp: r.followUp,
      tomorrowPlan: r.tomorrowPlan,
      supportRequest: r.supportRequest,
      totalWorkedMinutes: r.totalWorkedMinutes,
      actualEffortMinutes: r.actualEffortMinutes,
      unloggedGapMinutes: r.unloggedGapMinutes,
      unloggedGapReason: r.unloggedGapReason,
      submittedAt: r.submittedAt,
      // 위치이탈 자동감지 이벤트(있으면) — 고객사 등록 위치와 실제 이탈 위치 사이 거리를 보여준다.
      departureEvents: (departureById.get(r.id) ?? []).map((e) => ({
        at: e.at,
        locationMatch: e.locationMatch,
        locationDistanceMeters: e.locationDistanceMeters,
      })),
    })),
  });
});

/** 주간/월간 집계 — 제출건수, 근무일 대비 제출율, 인원별/고객사별 집계를 한 번에 내려준다. */
adminRouter.get('/summary', async (req, res) => {
  const parsed = adminQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '조회 조건을 확인하세요.' } });
  }
  const rows = await prisma.dailyWorkLog.findMany({
    where: buildAdminWhere(parsed.data),
    include: { user: { select: { name: true } } },
  });
  const departureById = await attachDepartureEvents(rows);

  const byUser = new Map<string, { name: string; count: number; simpleCount: number; detailedCount: number; totalMinutes: number }>();
  const byClient = new Map<string, number>();
  let detailedCount = 0;
  let unloggedGapCount = 0;
  let departureDetectedCount = 0;

  for (const row of rows) {
    if (departureById.has(row.id)) departureDetectedCount += 1;
    const cur = byUser.get(row.user.name) ?? { name: row.user.name, count: 0, simpleCount: 0, detailedCount: 0, totalMinutes: 0 };
    cur.count += 1;
    if (row.formType === 'DETAILED') { cur.detailedCount += 1; detailedCount += 1; } else { cur.simpleCount += 1; }
    cur.totalMinutes += row.totalWorkedMinutes ?? 0;
    byUser.set(row.user.name, cur);
    if (row.unloggedGapMinutes != null) unloggedGapCount += 1;

    (row.visitedClients ?? '').split(',').map((s) => s.trim()).filter(Boolean).forEach((name) => {
      byClient.set(name, (byClient.get(name) ?? 0) + 1);
    });
  }

  return res.json({
    success: true,
    data: {
      total: rows.length,
      detailedCount,
      simpleCount: rows.length - detailedCount,
      // 2026-09-29: "미등록 공백시간" 사유가 달린 건수 — 관리자가 한눈에 몇 건이나 있었는지 보게.
      unloggedGapCount,
      // 2026-09-29: 위치이탈 자동감지가 실제로 발생한 건수(고객사 등록 위치와 이탈 위치 거리 비교용).
      departureDetectedCount,
      byUser: Array.from(byUser.values())
        .map((u) => ({ name: u.name, count: u.count, simpleCount: u.simpleCount, detailedCount: u.detailedCount, avgMinutes: u.count > 0 ? Math.round(u.totalMinutes / u.count) : 0 }))
        .sort((a, b) => b.count - a.count),
      byClient: Array.from(byClient.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    },
  });
});

dailyWorkLogRouter.use('/admin', adminRouter);
