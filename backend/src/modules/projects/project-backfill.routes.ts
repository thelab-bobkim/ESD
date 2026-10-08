import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { nextProjectCode } from './project-code';
import {
  buildBackfillPlan,
  applyMergesAndExcludes,
  normalizeName,
  DEFAULT_EXCLUDED_WORK_TYPES,
  type BackfillPlan,
  type PlannedProject,
} from './project-backfill-plan';

/**
 * 2026-10-08: 공수(effort_logs) 데이터로 프로젝트를 만들어 연결하는 관리자 기능.
 *  - POST /projects/backfill/preview : DB를 전혀 바꾸지 않고 "무엇을 만들지"만 보여준다.
 *  - POST /projects/backfill/apply   : 관리자가 확인한 계획대로 프로젝트/Task/참여자를 만들고
 *                                      아직 프로젝트가 없는(project_id IS NULL) 공수에만 연결한다.
 * 기존 공수의 다른 필드(고객사명/시간/내용 등)와 이미 연결된 공수는 절대 바꾸지 않는다.
 * 여러 번 실행해도 같은 고객사는 기존 프로젝트를 재사용하므로 중복 생성되지 않는다(멱등).
 */
const backfillRoles = ['HR_ADMIN', 'SYSTEM_ADMIN'];

const bodySchema = z.object({
  excludedWorkTypes: z.array(z.string().max(40)).max(30).optional(),
  mergePairs: z.array(z.tuple([z.string().max(200), z.string().max(200)])).max(500).optional(),
  excludeKeys: z.array(z.string().max(200)).max(1000).optional(),
  // 이름이 포함 관계(예: 코스콤 ⊂ 코스콤안양연구센터)면 같은 고객사로 보고 자동으로 합친다.
  autoMergeContains: z.boolean().optional(),
});

function allMergePairs(plan: BackfillPlan, data: z.infer<typeof bodySchema>): [string, string][] {
  const manual = (data.mergePairs ?? []) as [string, string][];
  return data.autoMergeContains ? [...plan.containsPairs, ...manual] : manual;
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

let applyRunning = false;

async function loadPlan(excludedWorkTypes?: string[]): Promise<{ plan: BackfillPlan; today: string; excluded: string[] }> {
  const excluded = excludedWorkTypes && excludedWorkTypes.length ? excludedWorkTypes : DEFAULT_EXCLUDED_WORK_TYPES;
  const [rows, linkedCount, clients, existingProjects, users] = await Promise.all([
    prisma.effortLog.findMany({
      where: { projectId: null },
      select: { id: true, userId: true, workDate: true, clientName: true, projectName: true, workType: true, minutes: true, actualMinutes: true, sourceStatus: true },
    }),
    prisma.effortLog.count({ where: { projectId: { not: null } } }),
    prisma.client.findMany({ where: { name: { not: { startsWith: 'SAMPLE_' } } }, select: { id: true, name: true } }),
    prisma.project.findMany({ select: { id: true, code: true, name: true, clientId: true, status: true } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const sampleUserIds = new Set<string>(users.filter((u: { id: string; name: string }) => u.name.startsWith('SAMPLE_')).map((u: { id: string }) => u.id));
  const today = kstToday();
  const plan = buildBackfillPlan({
    rows: rows.map((r: any) => ({
      id: r.id,
      userId: r.userId,
      workDate: r.workDate,
      clientName: r.clientName ?? '',
      projectName: r.projectName ?? '',
      workType: r.workType ?? '',
      minutes: r.actualMinutes ?? r.minutes ?? 0,
      sourceStatus: r.sourceStatus,
    })),
    clients,
    existingProjects,
    users,
    sampleUserIds,
    today,
    excludedWorkTypes: excluded,
    alreadyLinkedCount: linkedCount,
  });
  return { plan, today, excluded };
}

function summarize(p: PlannedProject) {
  return {
    key: p.key,
    name: p.name,
    clientId: p.clientId,
    clientRegistered: Boolean(p.clientId),
    existingProject: p.existing,
    logCount: p.logCount,
    totalMinutes: p.totalMinutes,
    engineers: p.engineers.slice(0, 8),
    engineerCount: p.engineers.length,
    firstDate: p.firstDate,
    lastDate: p.lastDate,
    status: p.status,
    meaningful: p.meaningful,
    include: p.include,
    rawNames: p.rawNames,
    tasks: p.tasks.slice(0, 12).map((t) => ({ title: t.title, logCount: t.logCount, status: t.status, lastDate: t.lastDate })),
    taskCount: p.tasks.length,
  };
}

async function chunkedLink(tx: any, ids: string[], data: Record<string, string>, extraWhere: Record<string, null>) {
  let linked = 0;
  for (let i = 0; i < ids.length; i += 2000) {
    const res = await tx.effortLog.updateMany({ where: { id: { in: ids.slice(i, i + 2000) }, ...extraWhere }, data });
    linked += res.count;
  }
  return linked;
}

export function registerBackfillRoutes(router: any) {
  router.post('/backfill/preview', requireRole(...backfillRoles), async (req: any, res: any) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
    const { plan, today, excluded } = await loadPlan(parsed.data.excludedWorkTypes);
    const merged = applyMergesAndExcludes(plan, allMergePairs(plan, parsed.data), parsed.data.excludeKeys ?? [], today);
    const included = merged.filter((p) => p.include);
    return res.json({
      success: true,
      data: {
        today,
        excludedWorkTypes: excluded,
        totals: {
          projectsToCreate: included.filter((p) => !p.existing).length,
          projectsToReuse: included.filter((p) => p.existing).length,
          tasksToCreate: included.reduce((s, p) => s + p.tasks.length, 0),
          logsToLink: included.reduce((s, p) => s + p.logCount, 0),
          active: included.filter((p) => p.status === 'ACTIVE').length,
          completed: included.filter((p) => p.status === 'COMPLETED').length,
        },
        skipped: plan.skipped,
        projects: merged.map(summarize),
        // 자동 합치기를 켰다면 포함 관계 쌍은 이미 합쳐졌으므로 사람이 판단할 후보(오타 의심 등)만 남긴다.
        similarPairs: parsed.data.autoMergeContains ? plan.similarPairs.filter((p) => p.reason !== 'CONTAINS') : plan.similarPairs,
        autoMergedPairCount: parsed.data.autoMergeContains ? plan.containsPairs.length : 0,
      },
    });
  });

  router.post('/backfill/apply', requireRole(...backfillRoles), async (req: any, res: any) => {
    const parsed = bodySchema.extend({ confirm: z.literal(true) }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'CONFIRM_REQUIRED', message: '미리보기를 확인한 뒤 적용을 확정해야 합니다.' } });
    if (applyRunning) return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: '이미 적용이 진행 중입니다. 잠시 후 다시 시도하세요.' } });
    applyRunning = true;
    try {
      const actorId = req.authUser!.userId as string;
      const { plan, today } = await loadPlan(parsed.data.excludedWorkTypes);
      const merged = applyMergesAndExcludes(plan, allMergePairs(plan, parsed.data), parsed.data.excludeKeys ?? [], today);
      const targets = merged.filter((p) => p.include);

      const result = { createdProjects: 0, reusedProjects: 0, createdTasks: 0, linkedLogs: 0, addedMembers: 0, failed: [] as { name: string; message: string }[] };
      for (const p of targets) {
        try {
          const local = { createdProjects: 0, reusedProjects: 0, createdTasks: 0, linkedLogs: 0, addedMembers: 0 };
          await prisma.$transaction(async (tx: any) => {
            let projectId: string;
            if (p.existing) {
              projectId = p.existing.id;
              local.reusedProjects++;
            } else {
              const created = await tx.project.create({
                data: {
                  code: await nextProjectCode(tx),
                  name: p.name,
                  clientId: p.clientId,
                  status: p.status,
                  startDate: new Date(`${p.firstDate}T00:00:00.000Z`),
                  endDate: p.status === 'COMPLETED' ? new Date(`${p.lastDate}T00:00:00.000Z`) : null,
                  description: `고객사별 공수관리 데이터에서 자동 생성 (${p.firstDate} ~ ${p.lastDate}, 공수 ${p.logCount}건)`,
                  createdByUserId: actorId,
                },
                select: { id: true },
              });
              projectId = created.id;
              local.createdProjects++;
            }
            const members = await tx.projectMember.createMany({
              data: p.engineers.map((e) => ({ projectId, userId: e.userId, role: 'MEMBER' })),
              skipDuplicates: true,
            });
            local.addedMembers += members.count;

            const existingTasks = p.existing
              ? await tx.projectTask.findMany({ where: { projectId }, select: { id: true, title: true } })
              : [];
            const taskIdByKey = new Map<string, string>(existingTasks.map((t: any): [string, string] => [normalizeName(t.title), String(t.id)]));
            for (const t of p.tasks) {
              let taskId = taskIdByKey.get(t.key);
              if (!taskId) {
                const task = await tx.projectTask.create({
                  data: {
                    projectId,
                    title: t.title,
                    status: t.status,
                    assigneeId: t.assigneeId,
                    completedAt: t.status === 'DONE' ? new Date(`${t.lastDate}T00:00:00.000Z`) : null,
                    description: '공수 데이터의 작업명에서 자동 생성',
                  },
                  select: { id: true },
                });
                taskId = task.id;
                local.createdTasks++;
              }
              // 이 Task로 등록됐던 공수는 프로젝트+Task를 함께 연결한다(아직 미연결인 것만).
              local.linkedLogs += await chunkedLink(tx, t.logIds, { projectId, taskId: taskId as string }, { projectId: null } as any);
            }
            // Task에 연결되지 않은 나머지 공수는 프로젝트에만 연결한다(이미 연결된 것은 건드리지 않음).
            local.linkedLogs += await chunkedLink(tx, p.logIds, { projectId }, { projectId: null } as any);
          }, { timeout: 120_000, maxWait: 10_000 });
          // 트랜잭션이 성공한 경우에만 합산한다(실패하면 전부 롤백되므로 카운트에 넣지 않는다).
          result.createdProjects += local.createdProjects;
          result.reusedProjects += local.reusedProjects;
          result.createdTasks += local.createdTasks;
          result.linkedLogs += local.linkedLogs;
          result.addedMembers += local.addedMembers;
        } catch (e: any) {
          console.error('[project-backfill] 프로젝트 적용 실패:', p.name, e);
          result.failed.push({ name: p.name, message: String(e?.message ?? e).slice(0, 200) });
        }
      }

      await recordAuditLog({
        actorUserId: actorId,
        actionType: 'PROJECT_CHANGE',
        targetType: 'project_backfill',
        afterValue: { ...result, targets: targets.length, mergePairs: parsed.data.mergePairs ?? [], autoMergeContains: Boolean(parsed.data.autoMergeContains), excludeKeys: parsed.data.excludeKeys ?? [] },
      });
      return res.json({ success: true, data: result });
    } finally {
      applyRunning = false;
    }
  });
}
