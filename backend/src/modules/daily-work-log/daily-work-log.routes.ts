import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly, realDayWindow } from '../../common/attendance-helpers';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

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
export const dailyWorkLogRouter = Router();

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
  issues: z.string().min(1, '이슈/특이사항을 입력해주세요.').max(2000),
  followUp: z.string().max(2000).optional(),
  tomorrowPlan: z.string().min(1, '내일 예정 업무를 입력해주세요.').max(2000),
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
  const workDate = parseWorkDateParam(req.query.workDate);
  const { start, end } = realDayWindow(workDate);

  const [statuses, effortLogs, attendanceRecord, existing, me, unloggedGap] = await Promise.all([
    prisma.statusChangeLog.findMany({ where: { userId, changedAt: { gte: start, lt: end } }, orderBy: { changedAt: 'asc' } }),
    prisma.effortLog.findMany({ where: { userId, workDate }, orderBy: { startTime: 'asc' } }),
    prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } }),
    prisma.dailyWorkLog.findUnique({ where: { userId_workDate: { userId, workDate } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    // 퇴근 전에 미리 보여주기 위한 "지금 시점 기준" 공백 판정 — 실제 퇴근 시점엔 attendance.routes.ts
    // /clock-out이 그때의 clockOutAt 기준으로 다시 한번 독립적으로 계산해서 최종 검증한다.
    computeUnloggedGapMinutes(userId, workDate, new Date()),
  ]);

  const mailReports = me?.email
    ? await prisma.nightWorkMailReport.findMany({ where: { reporterEmail: me.email, workDate } })
    : [];

  const statusSet = new Set(statuses.map((s) => s.status as string));
  const formType: 'SIMPLE' | 'DETAILED' = [...statusSet].some((s) => DETAILED_STATUSES.has(s)) ? 'DETAILED' : 'SIMPLE';

  const visitedClientsSet = new Set<string>();
  effortLogs.forEach((e) => { if (e.clientName) visitedClientsSet.add(e.clientName); });
  mailReports.forEach((m) => { if (m.clientNameRaw) visitedClientsSet.add(m.clientNameRaw); });

  const workContentLines: string[] = [];
  effortLogs.forEach((e) => {
    const timeLabel = e.endTime ? `${hhmmLabel(e.startTime)}~${hhmmLabel(e.endTime)}` : `${hhmmLabel(e.startTime)}~진행중`;
    const label = [e.clientName, e.projectName].filter(Boolean).join(' · ') || '작업';
    workContentLines.push(`- [${label}] ${timeLabel}${e.description ? ' — ' + e.description : ''}`.trim());
  });
  mailReports.forEach((m) => {
    workContentLines.push(`- (${m.kind === 'NIGHT' ? '야간작업' : '주말작업'} 메일보고) [${m.clientNameRaw}] ${m.workContent || ''}`.trim());
  });

  const actualEffortMinutes = effortLogs.reduce((sum, e) => sum + (e.actualMinutes ?? e.minutes ?? 0), 0);
  const lastStatus = statuses[statuses.length - 1];

  return res.json({
    success: true,
    data: {
      workDate: workDate.toISOString().slice(0, 10),
      formType,
      workTypeSnapshot: lastStatus ? (STATUS_LABELS[lastStatus.status] ?? lastStatus.status) : null,
      visitedClients: [...visitedClientsSet].join(', ') || null,
      workContent: workContentLines.join('\n') || null,
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
  const workDate = parsed.data.workDate ? parseWorkDateParam(parsed.data.workDate) : todayDateOnly();
  const row = await upsertDailyWorkLog(userId, workDate, parsed.data);
  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'daily_work_log', targetId: row.id, afterValue: { workDate: row.workDate, formType: row.formType } });
  return res.json({ success: true, data: row });
});

// 아래부터는 관리자 전용(3단계) — night-work-mail 관리자 화면과 동일한 권한 체계.
const adminRouter = Router();
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

adminRouter.get('/list', async (req, res) => {
  const parsed = adminQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '조회 조건을 확인하세요.' } });
  }
  const rows = await prisma.dailyWorkLog.findMany({
    where: buildAdminWhere(parsed.data),
    include: { user: { select: { name: true, employeeNo: true, department: { select: { name: true } } } } },
    orderBy: [{ workDate: 'desc' }, { submittedAt: 'desc' }],
    take: 1000,
  });
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

  const byUser = new Map<string, { name: string; count: number; simpleCount: number; detailedCount: number; totalMinutes: number }>();
  const byClient = new Map<string, number>();
  let detailedCount = 0;
  let unloggedGapCount = 0;

  for (const row of rows) {
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
      byUser: Array.from(byUser.values())
        .map((u) => ({ name: u.name, count: u.count, simpleCount: u.simpleCount, detailedCount: u.detailedCount, avgMinutes: u.count > 0 ? Math.round(u.totalMinutes / u.count) : 0 }))
        .sort((a, b) => b.count - a.count),
      byClient: Array.from(byClient.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    },
  });
});

dailyWorkLogRouter.use('/admin', adminRouter);
