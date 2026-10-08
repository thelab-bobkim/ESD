import { prisma } from '../../common/prisma';
import { requireRole } from '../../common/guards/auth';

/**
 * 2026-10-08: 프로젝트 상세를 "통합 화면"으로 쓰기 위한 읽기 전용 조회 API.
 *  - GET /projects/:id/summary    : 엔지니어별·월별 공수, 최근 활동일
 *  - GET /projects/:id/effort     : 공수 이력(기간/엔지니어 필터 + 서버 페이징)
 *  - GET /projects/:id/daily-logs : 이 프로젝트에 공수를 등록한 (엔지니어, 날짜)의 일일업무일지
 * 어떤 데이터도 바꾸지 않는다. 관리자/팀장/인사관리자만 볼 수 있다(프로젝트 상세와 동일한 권한).
 */
const viewRoles = ['TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS_FOR_AGGREGATE = 20000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function mins(r: { actualMinutes: number | null; minutes: number | null }): number {
  return r.actualMinutes ?? r.minutes ?? 0;
}

/** from/to/userId 쿼리를 검증해 Prisma where 조각으로 만든다. 잘못된 값이면 null. */
function parseFilters(q: any): { where: Record<string, unknown> } | null {
  const where: Record<string, unknown> = {};
  const from = typeof q.from === 'string' && q.from ? q.from : null;
  const to = typeof q.to === 'string' && q.to ? q.to : null;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) return null;
  if (from || to) {
    where.workDate = {
      ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
      ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
    };
  }
  if (typeof q.userId === 'string' && q.userId) {
    if (!UUID_RE.test(q.userId)) return null;
    where.userId = q.userId;
  }
  return { where };
}

function badInput(res: any) {
  return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '조회 조건(기간/엔지니어)을 확인하세요.' } });
}

export function registerProjectInsightRoutes(router: any) {
  router.get('/:id/summary', requireRole(...viewRoles), async (req: any, res: any) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
    const projectId = req.params.id as string;
    const [byUser, byDate] = await Promise.all([
      prisma.effortLog.groupBy({ by: ['userId'], where: { projectId }, _sum: { actualMinutes: true, minutes: true }, _count: { _all: true }, _max: { workDate: true } }),
      prisma.effortLog.groupBy({ by: ['workDate'], where: { projectId }, _sum: { actualMinutes: true, minutes: true }, _count: { _all: true } }),
    ]);
    const users: { id: string; name: string }[] = byUser.length
      ? await prisma.user.findMany({ where: { id: { in: byUser.map((u: any) => u.userId) } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const byEngineer = byUser
      .map((u: any) => ({
        userId: u.userId as string,
        name: nameOf.get(u.userId) ?? '(알 수 없음)',
        minutes: Number(u._sum.actualMinutes ?? u._sum.minutes ?? 0),
        logCount: u._count._all as number,
        lastDate: u._max.workDate ? ymd(u._max.workDate) : null,
      }))
      .sort((a: any, b: any) => b.minutes - a.minutes || b.logCount - a.logCount);

    const monthly = new Map<string, { minutes: number; logCount: number }>();
    let lastActivityDate: string | null = null;
    let totalMinutes = 0;
    let totalLogs = 0;
    for (const d of byDate as any[]) {
      const day = ymd(d.workDate);
      const m = Number(d._sum.actualMinutes ?? d._sum.minutes ?? 0);
      const key = day.slice(0, 7);
      const cur = monthly.get(key) ?? { minutes: 0, logCount: 0 };
      cur.minutes += m;
      cur.logCount += d._count._all;
      monthly.set(key, cur);
      totalMinutes += m;
      totalLogs += d._count._all;
      if (!lastActivityDate || day > lastActivityDate) lastActivityDate = day;
    }
    const byMonth = [...monthly.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month));
    const thisMonth = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
    return res.json({
      success: true,
      data: { totalMinutes, totalLogs, lastActivityDate, thisMonthMinutes: monthly.get(thisMonth)?.minutes ?? 0, byEngineer, byMonth },
    });
  });

  router.get('/:id/effort', requireRole(...viewRoles), async (req: any, res: any) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
    const filters = parseFilters(req.query);
    if (!filters) return badInput(res);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '30'), 10) || 30));
    const where = { projectId: req.params.id as string, ...filters.where };
    const [total, sum, rows] = await Promise.all([
      prisma.effortLog.count({ where }),
      prisma.effortLog.aggregate({ where, _sum: { actualMinutes: true, minutes: true } }),
      prisma.effortLog.findMany({
        where,
        orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, workDate: true, workType: true, clientName: true, minutes: true, actualMinutes: true, startTime: true, endTime: true,
          description: true, sourceStatus: true,
          user: { select: { id: true, name: true } },
          task: { select: { id: true, title: true } },
        },
      }),
    ]);
    return res.json({
      success: true,
      data: {
        page, pageSize, total,
        totalMinutes: Number(sum._sum.actualMinutes ?? sum._sum.minutes ?? 0),
        rows: rows.map((r: any) => ({
          id: r.id,
          workDate: ymd(r.workDate),
          userId: r.user.id,
          userName: r.user.name,
          workType: r.workType,
          clientName: r.clientName,
          taskTitle: r.task?.title ?? null,
          startTime: r.startTime,
          endTime: r.endTime,
          minutes: mins(r),
          inProgress: r.endTime == null,
          description: r.description,
          sourceStatus: r.sourceStatus,
        })),
      },
    });
  });

  router.get('/:id/daily-logs', requireRole(...viewRoles), async (req: any, res: any) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
    const filters = parseFilters(req.query);
    if (!filters) return badInput(res);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
    const efforts = await prisma.effortLog.findMany({
      where: { projectId: req.params.id as string, ...filters.where },
      select: { userId: true, workDate: true, minutes: true, actualMinutes: true },
      orderBy: { workDate: 'desc' },
      take: MAX_ROWS_FOR_AGGREGATE,
    });
    // (엔지니어, 날짜) 단위로 이 프로젝트 공수를 합산한다.
    const pairs = new Map<string, { userId: string; workDate: Date; minutes: number }>();
    for (const e of efforts as any[]) {
      const key = `${e.userId}|${ymd(e.workDate)}`;
      const cur = pairs.get(key);
      if (cur) cur.minutes += mins(e); else pairs.set(key, { userId: e.userId, workDate: e.workDate, minutes: mins(e) });
    }
    const all = [...pairs.values()].sort((a, b) => b.workDate.getTime() - a.workDate.getTime() || a.userId.localeCompare(b.userId));
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    const logs: any[] = slice.length
      ? await prisma.dailyWorkLog.findMany({ where: { OR: slice.map((p) => ({ userId: p.userId, workDate: p.workDate })) } })
      : [];
    const users: { id: string; name: string }[] = slice.length
      ? await prisma.user.findMany({ where: { id: { in: [...new Set(slice.map((p) => p.userId))] } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const logOf = new Map(logs.map((l) => [`${l.userId}|${ymd(l.workDate)}`, l]));
    return res.json({
      success: true,
      data: {
        page, pageSize, total: all.length,
        rows: slice.map((p) => {
          const l = logOf.get(`${p.userId}|${ymd(p.workDate)}`);
          return {
            workDate: ymd(p.workDate),
            userId: p.userId,
            userName: nameOf.get(p.userId) ?? '(알 수 없음)',
            projectMinutes: p.minutes,
            hasLog: Boolean(l),
            visitedClients: l?.visitedClients ?? null,
            workContent: l?.workContent ?? null,
            issues: l?.issues ?? null,
            followUp: l?.followUp ?? null,
            tomorrowPlan: l?.tomorrowPlan ?? null,
            supportRequest: l?.supportRequest ?? null,
            totalWorkedMinutes: l?.totalWorkedMinutes ?? null,
          };
        }),
      },
    });
  });
}
