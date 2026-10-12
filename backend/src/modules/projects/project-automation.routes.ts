import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { nextProjectCode } from './project-code';
import { DEFAULT_EXCLUDED_WORK_TYPES } from './project-backfill-plan';
import { pickClientDefaults, groupUnlinked, pickTopEngineers, type EngineerTotal } from './project-automation-plan';

/**
 * 2026-10-08: "공지 없이도 쓰기 편하게 + 빠지는 데이터 없이" 를 위한 보조 API.
 *  - GET  /projects/my-defaults            : (직원) 고객사별 지난번 작업유형/프로젝트 → 입력폼이 미리 선택해 둔다.
 *  - GET  /projects/unlinked               : (관리자) 프로젝트에 연결되지 않은 공수를 고객사별로 모아 보여준다.
 *  - POST /projects/unlinked/assign        : (관리자) 선택한 고객사 공수를 기존/새 프로젝트에 연결한다(미연결분만).
 *  - POST /projects/managers/apply-suggested : (관리자) PM 미지정 프로젝트에 공수 최다 엔지니어를 PM으로 지정한다.
 * 이미 프로젝트에 연결된 공수와 이미 지정된 PM은 절대 바꾸지 않는다.
 */
const manageRoles = ['HR_ADMIN', 'SYSTEM_ADMIN'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULTS_LOOKBACK_DAYS = 120;

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

async function sampleUserIds(): Promise<string[]> {
  const users: { id: string }[] = await prisma.user.findMany({ where: { name: { startsWith: 'SAMPLE_' } }, select: { id: true } });
  return users.map((u) => u.id);
}

/** 프로젝트별 PM 후보(공수 최다 엔지니어). PM이 비어 있는 프로젝트만 대상. */
export async function loadSuggestedManagers(projectIds: string[]): Promise<Map<string, { userId: string; name: string; minutes: number }>> {
  const out = new Map<string, { userId: string; name: string; minutes: number }>();
  if (!projectIds.length) return out;
  const [groups, samples]: [any[], string[]] = await Promise.all([
    prisma.effortLog.groupBy({
      by: ['projectId', 'userId'],
      where: { projectId: { in: projectIds } },
      _sum: { actualMinutes: true, minutes: true },
      _count: { _all: true },
      _max: { workDate: true },
    }),
    sampleUserIds(),
  ]);
  const sampleSet = new Set<string>(samples);
  const totals: EngineerTotal[] = groups
    .filter((g: any) => !sampleSet.has(g.userId))
    .map((g: any) => ({
      projectId: g.projectId as string,
      userId: g.userId as string,
      minutes: Number(g._sum.actualMinutes ?? g._sum.minutes ?? 0),
      logCount: g._count._all as number,
      lastDate: g._max.workDate ? ymd(g._max.workDate) : null,
    }));
  const best = pickTopEngineers(totals);
  if (!best.size) return out;
  const users: { id: string; name: string }[] = await prisma.user.findMany({ where: { id: { in: [...new Set([...best.values()].map((b) => b.userId))] } }, select: { id: true, name: true } });
  const nameOf = new Map<string, string>(users.map((u) => [u.id, u.name]));
  for (const [pid, b] of best) out.set(pid, { userId: b.userId, name: nameOf.get(b.userId) ?? '(알 수 없음)', minutes: b.minutes });
  return out;
}

const assignSchema = z.object({
  names: z.array(z.string().min(1).max(200)).min(1).max(50),
  projectId: z.string().regex(UUID_RE).optional(),
  create: z.object({ name: z.string().trim().min(2).max(160), clientId: z.string().regex(UUID_RE).nullable().optional() }).optional(),
}).refine((v) => Boolean(v.projectId) !== Boolean(v.create), { message: '기존 프로젝트 또는 새 프로젝트 중 하나만 지정하세요.' });

let assignRunning = false;

export function registerProjectAutomationRoutes(router: any) {
  router.get('/my-defaults', async (req: any, res: any) => {
    const userId = req.authUser!.userId as string;
    const since = new Date(Date.now() - DEFAULTS_LOOKBACK_DAYS * 86400_000);
    const rows: any[] = await prisma.effortLog.findMany({
      where: { userId, workDate: { gte: since }, NOT: { clientName: '' } },
      orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
      take: 500,
      select: { clientName: true, workType: true, projectId: true, sourceStatus: true, description: true },
    });
    return res.json({ success: true, data: pickClientDefaults(rows) });
  });

  router.get('/unlinked', requireRole(...manageRoles), async (_req: any, res: any) => {
    const [samples, clients, projects]: [string[], any[], any[]] = await Promise.all([
      sampleUserIds(),
      prisma.client.findMany({ where: { name: { not: { startsWith: 'SAMPLE_' } } }, select: { id: true, name: true } }),
      prisma.project.findMany({ select: { id: true, code: true, name: true, clientId: true, status: true } }),
    ]);
    const rowsRaw = await prisma.effortLog.groupBy({
      by: ['clientName'],
      where: { projectId: null, workType: { notIn: DEFAULT_EXCLUDED_WORK_TYPES }, ...(samples.length ? { userId: { notIn: samples } } : {}) },
      _count: { _all: true },
      _sum: { actualMinutes: true, minutes: true },
      _max: { workDate: true },
    });
    const groups = groupUnlinked(
      (rowsRaw as any[]).map((r: any) => ({
        clientName: r.clientName as string,
        logCount: r._count._all as number,
        minutes: Number(r._sum.actualMinutes ?? r._sum.minutes ?? 0),
        lastDate: r._max.workDate ? ymd(r._max.workDate) : null,
      })),
      clients,
      projects,
    );
    return res.json({
      success: true,
      data: {
        totalGroups: groups.length,
        totalLogs: groups.reduce((s, g) => s + g.logCount, 0),
        groups: groups.slice(0, 100),
      },
    });
  });

  router.post('/unlinked/assign', requireRole(...manageRoles), async (req: any, res: any) => {
    const parsed = assignSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' } });
    if (assignRunning) return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: '다른 연결 작업이 진행 중입니다. 잠시 후 다시 시도하세요.' } });
    assignRunning = true;
    try {
      const actorId = req.authUser!.userId as string;
      const { names, projectId, create } = parsed.data;
      if (projectId) {
        const exists = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
        if (!exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
      }
      const samples = await sampleUserIds();
      const targets: { id: string; userId: string; workDate: Date }[] = await prisma.effortLog.findMany({
        where: { projectId: null, clientName: { in: names }, workType: { notIn: DEFAULT_EXCLUDED_WORK_TYPES }, ...(samples.length ? { userId: { notIn: samples } } : {}) },
        select: { id: true, userId: true, workDate: true },
        take: 50000,
      });
      if (!targets.length) return res.status(409).json({ success: false, error: { code: 'NO_TARGET', message: '연결할 공수가 없습니다. 이미 다른 곳에서 연결되었을 수 있으니 화면을 새로고침하세요.' } });

      const result = await prisma.$transaction(async (tx: any) => {
        let pid = projectId as string | undefined;
        let createdCode: string | null = null;
        if (create) {
          const first = targets.reduce((m, t) => (t.workDate < m ? t.workDate : m), targets[0].workDate);
          const last = targets.reduce((m, t) => (t.workDate > m ? t.workDate : m), targets[0].workDate);
          const code = await nextProjectCode(tx);
          const p = await tx.project.create({
            data: {
              code,
              name: create.name,
              clientId: create.clientId ?? null,
              status: 'ACTIVE',
              startDate: first,
              description: `연결되지 않은 공수를 관리자가 프로젝트로 만들어 연결 (${ymd(first)} ~ ${ymd(last)}, 공수 ${targets.length}건)`,
              createdByUserId: actorId,
            },
            select: { id: true, code: true },
          });
          pid = p.id;
          createdCode = p.code;
        }
        let linked = 0;
        for (let i = 0; i < targets.length; i += 2000) {
          const ids = targets.slice(i, i + 2000).map((t) => t.id);
          const r = await tx.effortLog.updateMany({ where: { id: { in: ids }, projectId: null }, data: { projectId: pid } });
          linked += r.count;
        }
        const members = await tx.projectMember.createMany({
          data: [...new Set(targets.map((t) => t.userId))].map((userId) => ({ projectId: pid, userId, role: 'MEMBER' })),
          skipDuplicates: true,
        });
        return { projectId: pid as string, createdCode, linked, addedMembers: members.count as number };
      }, { timeout: 120_000, maxWait: 10_000 });

      await recordAuditLog({
        actorUserId: actorId,
        actionType: 'PROJECT_CHANGE',
        targetType: 'project_unlinked_assign',
        targetId: result.projectId,
        afterValue: { names, ...result },
      });
      return res.json({ success: true, data: result });
    } finally {
      assignRunning = false;
    }
  });

  router.post('/managers/apply-suggested', requireRole(...manageRoles), async (req: any, res: any) => {
    if (req.body?.confirm !== true) return res.status(400).json({ success: false, error: { code: 'CONFIRM_REQUIRED', message: '확인 후 실행해야 합니다.' } });
    const actorId = req.authUser!.userId as string;
    const noManager: { id: string }[] = await prisma.project.findMany({ where: { managerId: null, status: { not: 'CANCELLED' } }, select: { id: true } });
    const suggestions = await loadSuggestedManagers(noManager.map((p) => p.id));
    let updated = 0;
    for (const [projectId, s] of suggestions) {
      const ok = await prisma.$transaction(async (tx: any) => {
        const r = await tx.project.updateMany({ where: { id: projectId, managerId: null }, data: { managerId: s.userId } });
        if (r.count !== 1) return false;
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: s.userId } },
          update: { role: 'PM' },
          create: { projectId, userId: s.userId, role: 'PM' },
        });
        return true;
      });
      if (ok) updated++;
    }
    await recordAuditLog({ actorUserId: actorId, actionType: 'PROJECT_CHANGE', targetType: 'project_manager_suggest', afterValue: { candidates: noManager.length, withSuggestion: suggestions.size, updated } });
    return res.json({ success: true, data: { candidates: noManager.length, withSuggestion: suggestions.size, updated } });
  });
}
