import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'));

/** attendance.routes.ts의 todayDateOnly()와 동일한 "자정(UTC)" 기준 날짜 계산 */
function dateOnlyUTC(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * 사용자별 "그 날짜"의 마지막 상태 변경 로그를 모아 상황판을 만든다 (간단한 MVP 집계 방식).
 * forDate를 안 넘기면 오늘 기준(라이브 상황판), 과거 날짜를 넘기면 그날의 스냅샷(캘린더 조회용)이 된다.
 */
async function buildStatusBoard(userIds?: string[], forDate: Date = dateOnlyUTC()) {
  const dayStart = forDate;
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: {
      ...(userIds ? { id: { in: userIds } } : {}),
      // 파일럿 초기 세팅용 SAMPLE_ 테스트 계정은 실제 상황판에서 제외한다.
      name: { not: { startsWith: 'SAMPLE_' } },
    },
    include: { department: true, assignedClient: true },
  });

  const board = await Promise.all(
    users.map(async (u) => {
      const statusOnDay = await prisma.statusChangeLog.findFirst({
        where: { userId: u.id, changedAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { changedAt: 'desc' },
      });
      const checkinOnDay = await prisma.residentCheckin.findFirst({
        where: { userId: u.id, checkinAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { checkinAt: 'desc' },
      });
      return {
        userId: u.id,
        name: u.name,
        department: u.department.name,
        client: u.assignedClient?.name ?? null,
        workType: u.workType,
        status: statusOnDay?.status ?? null,
        statusChangedAt: statusOnDay?.changedAt ?? null,
        statusSource: statusOnDay?.source ?? null,
        statusNote: statusOnDay?.note ?? null,
        lastConfirmedAt: checkinOnDay?.lastConfirmedAt ?? null,
      };
    })
  );
  return board;
}

dashboardRouter.get('/company', async (_req, res) => {
  const board = await buildStatusBoard();
  const summary: Record<string, number> = {};
  for (const row of board) {
    const key = row.status ?? 'UNKNOWN';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return res.json({ success: true, data: { summary, employees: board } });
});

dashboardRouter.get('/department/:id', async (req, res) => {
  const users = await prisma.user.findMany({ where: { departmentId: req.params.id }, select: { id: true } });
  const board = await buildStatusBoard(users.map((u) => u.id));
  return res.json({ success: true, data: board });
});

dashboardRouter.get('/client/:id', async (req, res) => {
  const users = await prisma.user.findMany({ where: { assignedClientId: req.params.id }, select: { id: true } });
  const board = await buildStatusBoard(users.map((u) => u.id));
  return res.json({ success: true, data: board });
});

const daySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** 캘린더에서 특정 날짜를 클릭했을 때, 그날의 상황판 스냅샷을 조회한다. */
dashboardRouter.get('/day', async (req, res) => {
  const parsed = daySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date(YYYY-MM-DD)가 필요합니다.' } });
  }
  const forDate = new Date(`${parsed.data.date}T00:00:00.000Z`);
  const board = await buildStatusBoard(undefined, forDate);
  const summary: Record<string, number> = {};
  for (const row of board) {
    const key = row.status ?? 'UNKNOWN';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return res.json({ success: true, data: { date: parsed.data.date, summary, employees: board } });
});

const monthSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * 캘린더 월별 요약 — 하루하루 셀에 표시할 간단한 숫자만 가볍게 집계한다.
 * (출근 인정: attendance_records.clock_in_at이 있는 날 / 근무확정: 퇴근까지 처리되어 실근무시간이 있는 날)
 */
dashboardRouter.get('/calendar', async (req, res) => {
  const parsed = monthSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'year, month가 필요합니다.' } });
  }
  const { year, month } = parsed.data;
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const records = await prisma.attendanceRecord.findMany({
    where: { workDate: { gte: from, lt: to } },
    select: { workDate: true, clockInAt: true, totalWorkedMinutes: true },
  });

  const byDate = new Map<string, { clockedIn: number; workedConfirmed: number }>();
  for (const r of records) {
    const key = r.workDate.toISOString().slice(0, 10);
    const cur = byDate.get(key) ?? { clockedIn: 0, workedConfirmed: 0 };
    if (r.clockInAt) cur.clockedIn += 1;
    if (r.totalWorkedMinutes != null) cur.workedConfirmed += 1;
    byDate.set(key, cur);
  }

  const days = Array.from(byDate.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return res.json({ success: true, data: { year, month, days } });
});
