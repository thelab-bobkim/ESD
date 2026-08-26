import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { realDayWindow } from '../../common/attendance-helpers';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'));

/**
 * "오늘"의 날짜 경계를 계산한다. attendance.routes.ts의 todayDateOnly()와 동일하게, 자정이 아니라
 * 새벽 3시(KST)를 하루의 경계로 삼는다(야간작업자 고려). 특정 날짜를 직접 넘기면 그 값을 그대로 쓴다.
 */
function dateOnlyUTC(d?: Date): Date {
  if (d) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const now = new Date();
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  return new Date(Date.UTC(kstShifted.getUTCFullYear(), kstShifted.getUTCMonth(), kstShifted.getUTCDate()));
}

/**
 * 사용자별 "그 날짜"의 마지막 상태 변경 로그를 모아 상황판을 만든다 (간단한 MVP 집계 방식).
 * forDate를 안 넘기면 오늘 기준(라이브 상황판), 과거 날짜를 넘기면 그날의 스냅샷(캘린더 조회용)이 된다.
 */
async function buildStatusBoard(userIds?: string[], forDate: Date = dateOnlyUTC()) {
  const workDateLabel = forDate;
  const { start: dayStart, end: dayEnd } = realDayWindow(workDateLabel);

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
      // 퇴근했으면 상황판에서 "마지막 상태" 대신 "퇴근완료"로 보여줄 수 있게 별도로 알려준다.
      // 단, 야간작업자는 퇴근 후에도 계속 상태를 등록할 수 있으므로, 퇴근시각 이후 새로 등록된
      // 상태가 있으면(=야간작업 등) 그 상태를 그대로 보여주고 "퇴근완료"로 덮어쓰지 않는다.
      const attendanceOnDay = await prisma.attendanceRecord.findUnique({
        where: { userId_workDate: { userId: u.id, workDate: workDateLabel } },
      });
      const clockedOut = Boolean(attendanceOnDay?.clockOutAt)
        && (!statusOnDay || statusOnDay.changedAt <= attendanceOnDay!.clockOutAt!);
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
        locationMatch: statusOnDay?.locationMatch ?? checkinOnDay?.locationMatch ?? null,
        locationDistanceMeters: statusOnDay?.locationDistanceMeters ?? checkinOnDay?.locationDistanceMeters ?? null,
        lastConfirmedAt: checkinOnDay?.lastConfirmedAt ?? null,
        clockedOut,
        clockOutAt: attendanceOnDay?.clockOutAt ?? null,
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

/**
 * 최근 활동 피드 — "지금 누가 뭘 눌렀는지"를 시간순으로 보여준다.
 * 예외/경고가 아니라 있는 그대로의 활동 중계라, 회사 전체의 움직임을 체감하기 좋다.
 */
dashboardRouter.get('/recent-activity', async (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const logs = await prisma.statusChangeLog.findMany({
    where: { user: { name: { not: { startsWith: 'SAMPLE_' } } } },
    orderBy: { changedAt: 'desc' },
    take: limit,
    include: { user: { include: { department: true } } },
  });
  const rows = logs.map((l) => ({
    userId: l.userId,
    name: l.user.name,
    department: l.user.department.name,
    status: l.status,
    changedAt: l.changedAt,
    source: l.source,
    note: l.note,
  }));
  return res.json({ success: true, data: rows });
});
