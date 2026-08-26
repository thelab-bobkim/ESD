import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

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
  const logs = await prisma.effortLog.findMany({
    where: {
      workDate: { gte: new Date(from), lte: new Date(to) },
      minutes: { not: null },
      ...(workType ? { workType } : {}),
    },
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
  });

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

  const rows = Array.from(byProject.values())
    .map((g) => ({
      projectName: g.projectName,
      clientName: g.clientName,
      totalMinutes: g.totalMinutes,
      workTypes: Array.from(g.workTypes),
      byUser: Array.from(g.byUser.values()).sort((a, b) => b.minutes - a.minutes),
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return res.json({ success: true, data: { from, to, rows } });
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
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { department: true } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '직원을 찾을 수 없습니다.' } });
  }

  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate: dayStart } } });
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
      totalWorkedMinutes: record?.totalWorkedMinutes ?? null,
      timeline,
    },
  });
});
