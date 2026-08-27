import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { realDayWindow } from '../../common/attendance-helpers';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'TEAM_LEAD'));

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => JSON.stringify(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

const rangeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

/**
 * 근무시간 누계(주/월 등) — 주52시간제 준수 여부를 확인하기 위한 기간별 실근무시간 합계.
 * from/to는 호출하는 쪽에서 "이번 주", "이번 달" 등으로 계산해서 넘긴다(YYYY-MM-DD).
 */
reportsRouter.get('/worktime-summary', async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'from, to가 필요합니다(YYYY-MM-DD).' } });
  }
  const { from, to } = parsed.data;
  const records = await prisma.attendanceRecord.findMany({
    where: { workDate: { gte: new Date(from), lte: new Date(to) } },
    include: { user: { include: { department: true } } },
  });

  const byUser = new Map<string, { userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number }>();
  for (const r of records) {
    if (!r.totalWorkedMinutes) continue; // 퇴근 처리(확정)된 날만 집계
    const key = r.userId;
    const cur = byUser.get(key) ?? {
      userId: r.userId,
      name: r.user.name,
      employeeNo: r.user.employeeNo,
      department: r.user.department.name,
      totalMinutes: 0,
      days: 0,
    };
    cur.totalMinutes += r.totalWorkedMinutes;
    cur.days += 1;
    byUser.set(key, cur);
  }

  const rows = Array.from(byUser.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
  return res.json({ success: true, data: { from, to, rows } });
});

/**
 * 프로젝트/고객사별 공수(工數) 집계 — 완료된(작업완료 시간이 입력된) 공수기록만 합산한다.
 */
reportsRouter.get('/effort-summary', async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'from, to가 필요합니다(YYYY-MM-DD).' } });
  }
  const { from, to } = parsed.data;
  const workType = typeof req.query.workType === 'string' && req.query.workType !== 'ALL' ? req.query.workType : undefined;

  const fetchLogs = (fromD: Date, toD: Date) =>
    prisma.effortLog.findMany({
      where: { workDate: { gte: fromD, lte: toD }, minutes: { not: null }, ...(workType ? { workType } : {}) },
      include: { user: { select: { name: true, employeeNo: true } } },
      orderBy: { workDate: 'desc' },
    });

  const fromDate = new Date(from);
  const toDate = new Date(to);
  // 고객사명이 없는 기록(사내 업무일지 등)은 이 "고객사별" 리포트에서 제외한다 —
  // 아직 전사 도입 전이라 "(미지정)" 묶음이 관리적으로 의미가 없기 때문.
  const logs = (await fetchLogs(fromDate, toDate)).filter((l) => l.clientName && l.clientName.trim());

  // 전기간(직전 동일 길이 구간) 대비 증감을 보여주기 위해 이전 구간도 같이 집계한다.
  const periodMs = toDate.getTime() - fromDate.getTime() + 24 * 60 * 60 * 1000;
  const prevTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const prevFrom = new Date(prevTo.getTime() - periodMs + 24 * 60 * 60 * 1000);
  const prevLogs = (await fetchLogs(prevFrom, prevTo)).filter((l) => l.clientName && l.clientName.trim());
  const prevByClient = new Map<string, number>();
  for (const l of prevLogs) {
    const key = l.clientName;
    prevByClient.set(key, (prevByClient.get(key) ?? 0) + (l.minutes ?? 0));
  }

  interface ProjectGroup {
    projectName: string;
    clientName: string;
    totalMinutes: number;
    workTypes: Set<string>;
    byUser: Map<string, { userId: string; name: string; minutes: number }>;
  }
  const byProject = new Map<string, ProjectGroup>();
  for (const l of logs) {
    const key = `${l.clientName}::${l.projectName}`;
    const group = byProject.get(key) ?? { projectName: l.projectName || '(미지정)', clientName: l.clientName || '(미지정)', totalMinutes: 0, workTypes: new Set<string>(), byUser: new Map() };
    group.totalMinutes += l.minutes ?? 0;
    group.workTypes.add(l.workType);
    const u = group.byUser.get(l.userId) ?? { userId: l.userId, name: l.user.name, minutes: 0 };
    u.minutes += l.minutes ?? 0;
    group.byUser.set(l.userId, u);
    byProject.set(key, group);
  }

  const projectRows = Array.from(byProject.values()).map((g) => ({
    projectName: g.projectName,
    clientName: g.clientName,
    totalMinutes: g.totalMinutes,
    workTypes: Array.from(g.workTypes),
    byUser: Array.from(g.byUser.values()).sort((a, b) => b.minutes - a.minutes),
  }));

  // 고객사 단위로 다시 묶는다 — 관리 판단은 프로젝트 단위가 아니라 "이 고객사에 총 몇 시간 썼는지"가 기준이라서.
  interface ClientGroup {
    clientName: string;
    totalMinutes: number;
    projects: typeof projectRows;
    engineerMinutes: Map<string, { userId: string; name: string; minutes: number }>;
    workTypeMinutes: Map<string, number>;
  }
  const byClient = new Map<string, ClientGroup>();
  for (const p of projectRows) {
    const group = byClient.get(p.clientName) ?? {
      clientName: p.clientName, totalMinutes: 0, projects: [] as typeof projectRows, engineerMinutes: new Map(), workTypeMinutes: new Map(),
    };
    group.totalMinutes += p.totalMinutes;
    group.projects.push(p);
    for (const u of p.byUser) {
      const cur = group.engineerMinutes.get(u.userId) ?? { userId: u.userId, name: u.name, minutes: 0 };
      cur.minutes += u.minutes;
      group.engineerMinutes.set(u.userId, cur);
    }
    for (const wt of p.workTypes) {
      // workTypes는 프로젝트 안에 섞인 유형 목록이라, 프로젝트 총 시간을 유형 수로 나눠 근사치로 배분한다.
      group.workTypeMinutes.set(wt, (group.workTypeMinutes.get(wt) ?? 0) + p.totalMinutes / p.workTypes.length);
    }
    byClient.set(p.clientName, group);
  }

  const clients = Array.from(byClient.values())
    .map((g) => {
      const engineers = Array.from(g.engineerMinutes.values()).sort((a, b) => b.minutes - a.minutes);
      const topEngineer = engineers[0] ?? null;
      const concentrationPct = topEngineer && g.totalMinutes > 0 ? Math.round((topEngineer.minutes / g.totalMinutes) * 100) : 0;
      const topWorkType = Array.from(g.workTypeMinutes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const prevMinutes = prevByClient.get(g.clientName) ?? 0;
      const trendPct = prevMinutes > 0 ? Math.round(((g.totalMinutes - prevMinutes) / prevMinutes) * 100) : null;
      return {
        clientName: g.clientName,
        totalMinutes: g.totalMinutes,
        projectCount: g.projects.length,
        engineerCount: engineers.length,
        topEngineerName: topEngineer?.name ?? null,
        concentrationPct, // 한 엔지니어가 이 고객사 공수의 몇 %를 담당하는지(편중도)
        topWorkType,
        trendPct, // 직전 동일기간 대비 증감률(%). 이전 데이터 없으면 null
        projects: g.projects.sort((a, b) => b.totalMinutes - a.totalMinutes),
      };
    })
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return res.json({ success: true, data: { from, to, clients } });
});

reportsRouter.get('/effort-export', async (req, res) => {
  const logs = await prisma.effortLog.findMany({
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
    take: 2000,
  });
  const rows = logs.map((l) => ({
    employeeNo: l.user.employeeNo,
    name: l.user.name,
    workDate: l.workDate.toISOString().slice(0, 10),
    clientName: l.clientName,
    projectName: l.projectName,
    workType: l.workType,
    startTime: l.startTime.toISOString(),
    endTime: l.endTime?.toISOString() ?? '',
    minutes: l.minutes ?? '',
    description: l.description ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="effort-export.csv"');
  return res.send(toCSV(rows));
});

reportsRouter.get('/attendance-export', async (req, res) => {
  const records = await prisma.attendanceRecord.findMany({
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
    take: 1000,
  });
  const rows = records.map((r) => ({
    employeeNo: r.user.employeeNo,
    name: r.user.name,
    workDate: r.workDate.toISOString().slice(0, 10),
    clockInAt: r.clockInAt?.toISOString() ?? '',
    clockOutAt: r.clockOutAt?.toISOString() ?? '',
    totalWorkedMinutes: r.totalWorkedMinutes ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.csv"');
  return res.send(toCSV(rows));
});

reportsRouter.get('/night-work-export', async (req, res) => {
  const sessions = await prisma.nightWorkSession.findMany({
    include: { user: { select: { name: true, employeeNo: true } }, leaveConversionRequest: true },
    orderBy: { startedAt: 'desc' },
    take: 1000,
  });
  const rows = sessions.map((s) => ({
    employeeNo: s.user.employeeNo,
    name: s.user.name,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? '',
    workedMinutes: s.workedMinutes ?? '',
    conversionStatus: s.leaveConversionRequest?.status ?? 'NONE',
    convertedMinutes: s.leaveConversionRequest?.convertedMinutes ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="night-work-export.csv"');
  return res.send(toCSV(rows));
});

const daySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * 하루 단위 출퇴근 상세 — worktime-summary와 달리 "퇴근 전(진행중)"인 사람도 포함해서
 * 출근시각/퇴근시각을 있는 그대로 보여준다. "오늘 출퇴근 현황을 매일 확인"하는 용도.
 */
reportsRouter.get('/attendance-detail', async (req, res) => {
  const parsed = daySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date(YYYY-MM-DD)가 필요합니다.' } });
  }
  const workDate = new Date(`${parsed.data.date}T00:00:00.000Z`);
  const records = await prisma.attendanceRecord.findMany({
    where: { workDate, user: { name: { not: { startsWith: 'SAMPLE_' } } } },
    include: { user: { include: { department: true } } },
    orderBy: { clockInAt: 'asc' },
  });
  const rows = records.map((r) => ({
    userId: r.userId,
    employeeNo: r.user.employeeNo,
    name: r.user.name,
    department: r.user.department.name,
    clockInAt: r.clockInAt,
    clockOutAt: r.clockOutAt,
    clockOutLocation: r.clockOutLocation,
    totalWorkedMinutes: r.totalWorkedMinutes,
  }));
  return res.json({ success: true, data: { date: parsed.data.date, rows } });
});

const dailyTimelineSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId: z.string().min(1),
});

/**
 * 특정 직원의 특정 날짜 상태변화 타임라인 — "몇시부터 몇시까지 뭘 했는지"를 순서대로 보여준다.
 * 각 구간의 소요시간은 "다음 상태로 바뀐 시각(또는 퇴근시각)"과의 차이로 계산한다.
 */
reportsRouter.get('/daily-timeline', async (req, res) => {
  const parsed = dailyTimelineSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date, userId가 필요합니다.' } });
  }
  const { date, userId } = parsed.data;
  const workDateLabel = new Date(`${date}T00:00:00.000Z`);
  const { start: dayStart, end: dayEnd } = realDayWindow(workDateLabel);

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { department: true } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '직원을 찾을 수 없습니다.' } });
  }

  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate: workDateLabel } } });
  const logs = await prisma.statusChangeLog.findMany({
    where: { userId, changedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { changedAt: 'asc' },
  });

  const timeline = logs.map((log, i) => {
    const nextChangedAt: Date | null = logs[i + 1]?.changedAt ?? record?.clockOutAt ?? null;
    const isOngoing = !nextChangedAt;
    const endTime = nextChangedAt ?? new Date();
    const durationMinutes = Math.max(0, Math.round((endTime.getTime() - log.changedAt.getTime()) / 60000));
    return {
      status: log.status,
      changedAt: log.changedAt,
      note: log.note,
      durationMinutes,
      ongoing: isOngoing,
    };
  });

  return res.json({
    success: true,
    data: {
      date,
      name: user.name,
      department: user.department.name,
      clockInAt: record?.clockInAt ?? null,
      clockOutAt: record?.clockOutAt ?? null,
      clockOutLocation: record?.clockOutLocation ?? null,
      totalWorkedMinutes: record?.totalWorkedMinutes ?? null,
      timeline,
    },
  });
});
