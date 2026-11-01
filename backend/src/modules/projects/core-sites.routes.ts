import { createRouter } from '../../common/async-router';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

// 2026-11-01: 프로젝트관리 "핵심 사이트 TOP 10" — 기간 내 실공수가 가장 많은 프로젝트(사이트) 순위.
// 실공수는 작업기록 한 건씩 actual_minutes(없으면 minutes)를 더한다. 조회 전용.
export const coreSitesRouter = createRouter();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

coreSitesRouter.get('/core-sites', requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  const now = new Date();
  const fromQ = String(req.query.from ?? '');
  const toQ = String(req.query.to ?? '');
  const from = DATE_RE.test(fromQ) ? fromQ : ymd(new Date(now.getTime() - 90 * 86400000));
  const to = DATE_RE.test(toQ) ? toQ : ymd(now);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(30, Math.max(1, Math.floor(limitRaw))) : 10;

  const ranked = await prisma.$queryRaw<{ project_id: string; minutes: number }[]>`
    select project_id, sum(coalesce(actual_minutes, minutes, 0))::int as minutes
    from effort_logs
    where project_id is not null and work_date >= ${from}::date and work_date <= ${to}::date
    group by project_id
    having sum(coalesce(actual_minutes, minutes, 0)) > 0
    order by 2 desc
    limit ${limit}`;
  const totalRows = await prisma.$queryRaw<{ total: number }[]>`
    select coalesce(sum(coalesce(actual_minutes, minutes, 0)), 0)::int as total
    from effort_logs
    where project_id is not null and work_date >= ${from}::date and work_date <= ${to}::date`;
  const totalMinutes = Number(totalRows[0]?.total ?? 0);
  const ids = ranked.map((r) => r.project_id);
  if (ids.length === 0) {
    return res.json({ success: true, data: { from, to, limit, totalMinutes, items: [] } });
  }
  const projects = await prisma.project.findMany({
    where: { id: { in: ids } },
    include: {
      client: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
    },
  });
  const rows = await prisma.effortLog.findMany({
    where: {
      projectId: { in: ids },
      workDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
    },
    select: { projectId: true, userId: true, workDate: true, minutes: true, actualMinutes: true, workType: true, description: true },
    orderBy: { workDate: 'desc' },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: Array.from(new Set(rows.map((r) => r.userId))) } },
    select: { id: true, name: true },
  });
  const nameBy = new Map(users.map((u) => [u.id, u.name]));
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  const items = ranked.map((r, i) => {
    const p = projectBy.get(r.project_id);
    if (!p) return null;
    const prs = rows.filter((e) => e.projectId === r.project_id);
    const engMap = new Map<string, number>();
    const monMap = new Map<string, number>();
    for (const e of prs) {
      const m = e.actualMinutes ?? e.minutes ?? 0;
      engMap.set(e.userId, (engMap.get(e.userId) ?? 0) + m);
      const key = ymd(e.workDate).slice(0, 7);
      monMap.set(key, (monMap.get(key) ?? 0) + m);
    }
    const pct = (v: number, t: number) => (t > 0 ? Math.round((v * 1000) / t) / 10 : 0);
    const engineers = Array.from(engMap.entries())
      .map(([userId, minutes]) => ({ userId, name: nameBy.get(userId) ?? '-', minutes, pct: pct(minutes, r.minutes) }))
      .sort((a, b) => b.minutes - a.minutes);
    const monthly = Array.from(monMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, minutes]) => ({ month, minutes }));
    const recent = prs.slice(0, 8).map((e) => ({
      workDate: ymd(e.workDate),
      userName: nameBy.get(e.userId) ?? '-',
      minutes: e.actualMinutes ?? e.minutes ?? 0,
      workType: e.workType,
      description: (e.description ?? '').slice(0, 80),
    }));
    return {
      rank: i + 1,
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      client: p.client ? p.client.name : null,
      manager: p.manager ? { id: p.manager.id, name: p.manager.name } : null,
      minutes: r.minutes,
      sharePct: pct(r.minutes, totalMinutes),
      engineerCount: engineers.length,
      engineers: engineers.slice(0, 8),
      monthly,
      recent,
      lastActivityDate: prs[0] ? ymd(prs[0].workDate) : null,
    };
  });
  return res.json({ success: true, data: { from, to, limit, totalMinutes, items: items.filter(Boolean) } });
});
