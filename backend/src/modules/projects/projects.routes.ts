import { z } from 'zod';
import { createRouter } from '../../common/async-router';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { registerBackfillRoutes } from './project-backfill.routes';
import { registerProjectInsightRoutes } from './project-insights.routes';

// 2026-10-01 수정(Genspark 0001-0008 병합, C-2 일관성 유지): 이 모듈도 다른 22개 라우트 모듈과 동일하게
// async 핸들러 예외가 프로세스를 종료시키지 않도록 createRouter()를 쓴다(common/async-router.ts 참고).
export const projectsRouter = createRouter();
projectsRouter.use(requireAuth);

const adminRoles = ['TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'];
function canManage(req: any) {
  return Boolean(req.authUser?.roles?.some((r: string) => adminRoles.includes(r)));
}
function asDate(value?: string | null) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}
function dateOnly(d?: Date | null) {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** 직원 공수입력용: 본인이 참여한 활성 프로젝트와 Task 목록. 관리자/팀장은 전체 프로젝트를 볼 수 있다. */
projectsRouter.get('/options', async (req, res) => {
  const userId = req.authUser!.userId;
  const manageable = canManage(req);
  const projects = await prisma.project.findMany({
    where: {
      status: { in: ['PLANNED', 'ACTIVE', 'ON_HOLD'] },
      ...(manageable ? {} : { OR: [{ managerId: userId }, { members: { some: { userId } } }] }),
    },
    include: {
      client: { select: { id: true, name: true } },
      tasks: {
        where: { status: { not: 'DONE' } },
        select: { id: true, title: true, status: true, assigneeId: true },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      },
    },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  });
  return res.json({
    success: true,
    data: projects.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, client: p.client, tasks: p.tasks })),
  });
});

/** 프로젝트 생성/배정 화면의 공통 참조데이터. */
projectsRouter.get('/reference-data', requireRole(...adminRoles), async (_req, res) => {
  const [users, clients] = await Promise.all([
    prisma.user.findMany({
      where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
      select: { id: true, name: true, employeeNo: true, department: { select: { name: true } } },
      orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
    }),
    prisma.client.findMany({
      where: { name: { not: { startsWith: 'SAMPLE_' } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return res.json({ success: true, data: { users: users.map((u) => ({ ...u, department: u.department.name })), clients } });
});

/**
 * 프로젝트 관리화면용 목록.
 * 2026-10-01 수정(ESD 2.0 검증 중 발견 — 성능): 원래 패치안은 프로젝트마다 EffortLog 원본 행을
 * 전부 include해서 애플리케이션 메모리에서 합산했다. EffortLog는 수십만 건까지 누적될 수 있어
 * (사용자 요청사항 9 — 향후 데이터 규모 가정) 목록 화면을 열 때마다 이 많은 행을 그대로 읽어오면
 * 응답시간/메모리 모두 악화된다. groupBy로 DB에서 프로젝트별 합계만 집계해서 가져온다.
 */
projectsRouter.get('/', requireRole(...adminRoles), async (_req, res) => {
  const [projects, effortTotals] = await Promise.all([
    prisma.project.findMany({
      include: {
        client: { select: { id: true, name: true } },
        manager: { select: { id: true, name: true, department: { select: { name: true } } } },
        members: { include: { user: { select: { id: true, name: true, department: { select: { name: true } } } } } },
        tasks: { select: { id: true, status: true, plannedMinutes: true } },
      },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }, { name: 'asc' }],
    }),
    prisma.effortLog.groupBy({
      by: ['projectId'],
      where: { projectId: { not: null } },
      _sum: { actualMinutes: true, minutes: true },
      _max: { workDate: true },
    }),
  ]);
  const effortByProject = new Map(effortTotals.map((e) => [e.projectId as string, Number(e._sum.actualMinutes ?? e._sum.minutes ?? 0)]));
  const lastActivityByProject = new Map(effortTotals.map((e) => [e.projectId as string, e._max.workDate ? dateOnly(e._max.workDate) : null]));
  return res.json({
    success: true,
    data: projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      client: p.client,
      status: p.status,
      priority: p.priority,
      difficulty: p.difficulty,
      plannedMinutes: p.plannedMinutes,
      actualMinutes: effortByProject.get(p.id) ?? 0,
      lastActivityDate: lastActivityByProject.get(p.id) ?? null,
      startDate: dateOnly(p.startDate),
      endDate: dateOnly(p.endDate),
      description: p.description,
      manager: p.manager ? { id: p.manager.id, name: p.manager.name, department: p.manager.department.name } : null,
      members: p.members.map((m) => ({ id: m.id, userId: m.userId, name: m.user.name, department: m.user.department.name, role: m.role, allocationPct: m.allocationPct })),
      taskSummary: {
        total: p.tasks.length,
        done: p.tasks.filter((t) => t.status === 'DONE').length,
        inProgress: p.tasks.filter((t) => t.status === 'IN_PROGRESS').length,
        blocked: p.tasks.filter((t) => t.status === 'BLOCKED').length,
      },
    })),
  });
});

const projectSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(160),
  clientId: z.string().uuid().nullable().optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  plannedMinutes: z.number().int().min(0).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
});

projectsRouter.post('/', requireRole(...adminRoles), async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' } });
  const d = parsed.data;
  const duplicate = await prisma.project.findUnique({ where: { code: d.code } });
  if (duplicate) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PROJECT_CODE', message: '이미 사용 중인 프로젝트 코드입니다.' } });
  const created = await prisma.project.create({
    data: {
      code: d.code,
      name: d.name,
      clientId: d.clientId ?? null,
      status: d.status ?? 'PLANNED',
      priority: d.priority ?? 'NORMAL',
      difficulty: d.difficulty ?? 3,
      plannedMinutes: d.plannedMinutes ?? null,
      startDate: asDate(d.startDate),
      endDate: asDate(d.endDate),
      description: d.description ?? null,
      managerId: d.managerId ?? null,
      createdByUserId: req.authUser!.userId,
      ...(d.managerId ? { members: { create: { userId: d.managerId, role: 'PM', allocationPct: 100 } } } : {}),
    },
  });
  await recordAuditLog({ actorUserId: req.authUser!.userId, actionType: 'PROJECT_CHANGE', targetType: 'project', targetId: created.id, afterValue: { code: created.code, name: created.name } });
  return res.status(201).json({ success: true, data: created });
});

projectsRouter.patch('/:id', requireRole(...adminRoles), async (req, res) => {
  const parsed = projectSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' } });
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
  const d = parsed.data;
  if (d.code !== undefined && d.code !== existing.code) {
    const duplicate = await prisma.project.findUnique({ where: { code: d.code } });
    if (duplicate) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PROJECT_CODE', message: '이미 사용 중인 프로젝트 코드입니다.' } });
  }
  const updated = await prisma.project.update({
    where: { id: req.params.id },
    data: {
      ...(d.code !== undefined ? { code: d.code } : {}),
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.clientId !== undefined ? { clientId: d.clientId } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.priority !== undefined ? { priority: d.priority } : {}),
      ...(d.difficulty !== undefined ? { difficulty: d.difficulty } : {}),
      ...(d.plannedMinutes !== undefined ? { plannedMinutes: d.plannedMinutes } : {}),
      ...(d.startDate !== undefined ? { startDate: asDate(d.startDate) } : {}),
      ...(d.endDate !== undefined ? { endDate: asDate(d.endDate) } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.managerId !== undefined ? { managerId: d.managerId } : {}),
    },
  });
  if (d.managerId) await prisma.projectMember.upsert({ where: { projectId_userId: { projectId: existing.id, userId: d.managerId } }, update: { role: 'PM' }, create: { projectId: existing.id, userId: d.managerId, role: 'PM' } });
  await recordAuditLog({ actorUserId: req.authUser!.userId, actionType: 'PROJECT_CHANGE', targetType: 'project', targetId: updated.id, beforeValue: existing, afterValue: updated });
  return res.json({ success: true, data: updated });
});

const memberSchema = z.object({ userId: z.string().uuid(), role: z.string().trim().min(1).max(40).default('MEMBER'), allocationPct: z.number().int().min(0).max(100).default(100) });
projectsRouter.post('/:id/members', requireRole(...adminRoles), async (req, res) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '참여자 정보를 확인하세요.' } });
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: req.params.id, userId: parsed.data.userId } },
    update: { role: parsed.data.role, allocationPct: parsed.data.allocationPct },
    create: { projectId: req.params.id, ...parsed.data },
  });
  return res.json({ success: true, data: member });
});

projectsRouter.delete('/:id/members/:userId', requireRole(...adminRoles), async (req, res) => {
  await prisma.projectMember.deleteMany({ where: { projectId: req.params.id, userId: req.params.userId } });
  return res.json({ success: true, data: { deleted: true } });
});

const taskCreateSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().max(4000).nullable().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  plannedMinutes: z.number().int().min(0).nullable().optional(),
  dueDate: z.string().nullable().optional(),
});
projectsRouter.post('/:id/tasks', requireRole(...adminRoles), async (req, res) => {
  const parsed = taskCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? 'Task 입력값을 확인하세요.' } });
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
  const d = parsed.data;
  const task = await prisma.projectTask.create({
    data: {
      projectId: req.params.id,
      title: d.title,
      description: d.description ?? null,
      status: d.status ?? 'TODO',
      priority: d.priority ?? 'NORMAL',
      difficulty: d.difficulty ?? 3,
      assigneeId: d.assigneeId ?? null,
      plannedMinutes: d.plannedMinutes ?? null,
      dueDate: asDate(d.dueDate),
      completedAt: d.status === 'DONE' ? new Date() : null,
    },
  });
  // Task 담당자가 아직 프로젝트 참여자로 등록되지 않았다면 자동으로 참여자 목록에 추가한다(배정과
  // 참여자 목록이 어긋나지 않도록). 이미 참여 중이면(update:{}) 기존 role/allocationPct는 보존한다.
  if (d.assigneeId) await prisma.projectMember.upsert({ where: { projectId_userId: { projectId: req.params.id, userId: d.assigneeId } }, update: {}, create: { projectId: req.params.id, userId: d.assigneeId } });
  return res.status(201).json({ success: true, data: task });
});

projectsRouter.patch('/tasks/:taskId', async (req, res) => {
  const parsed = taskCreateSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Task 입력값을 확인하세요.' } });
  const task = await prisma.projectTask.findUnique({ where: { id: req.params.taskId } });
  if (!task) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Task를 찾을 수 없습니다.' } });
  const selfAssigned = task.assigneeId === req.authUser!.userId;
  if (!canManage(req) && !selfAssigned) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '본인에게 배정된 Task만 변경할 수 있습니다.' } });
  // 일반 직원은 상태만 변경 가능. 난이도/예상공수/담당자/기한 등 평가 근거가 되는 메타데이터는
  // 관리자만 바꿀 수 있다(사용자 요청사항 3) — 일반 직원이 보낸 값 중 status 외에는 전부 버린다.
  const d: Partial<z.infer<typeof taskCreateSchema>> = canManage(req) ? parsed.data : { status: parsed.data.status };
  // 2026-10-01 수정(ESD 2.0 검증 중 발견): 이미 DONE인 Task를 다시 DONE으로 재저장하면(화면을
  // 두 번 누르는 등) completedAt이 매번 지금 시각으로 덮어써져 원래 완료시각이 사라졌다. 상태가
  // 실제로 바뀔 때만 completedAt을 갱신한다.
  const statusChanged = d.status !== undefined && d.status !== task.status;
  const updated = await prisma.projectTask.update({
    where: { id: task.id },
    data: {
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(statusChanged ? { completedAt: d.status === 'DONE' ? new Date() : null } : {}),
      ...(d.priority !== undefined ? { priority: d.priority } : {}),
      ...(d.difficulty !== undefined ? { difficulty: d.difficulty } : {}),
      ...(d.assigneeId !== undefined ? { assigneeId: d.assigneeId } : {}),
      ...(d.plannedMinutes !== undefined ? { plannedMinutes: d.plannedMinutes } : {}),
      ...(d.dueDate !== undefined ? { dueDate: asDate(d.dueDate) } : {}),
    },
  });
  return res.json({ success: true, data: updated });
});

/**
 * 직원 개인 성과 화면(사용자 요청사항 5): "회사가 나를 어떤 데이터로 보는지" 본인이 직접 확인할 수
 * 있어야 한다는 요구사항 — 관리자용 /performance/summary와 집계 로직은 같지만 본인 데이터만 반환하고
 * 별도 권한이 필요 없다(로그인만 하면 누구나 자기 자신의 데이터는 볼 수 있음). 이 엔드포인트는
 * 원안(ChatGPT 패치)에는 없었다 — 패치 파일 끝에 이 기능을 설명하는 주석만 남아있고 실제 구현이
 * 누락되어 있었다(검증 중 발견, 2026-10-01).
 */
projectsRouter.get('/me/performance', async (req, res) => {
  const userId = req.authUser!.userId;
  const query = z.object({ from: z.string().optional(), to: z.string().optional() }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '기간을 확인하세요.' } });
  const now = new Date();
  const from = query.data.from ? asDate(query.data.from)! : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const toBase = query.data.to ? asDate(query.data.to)! : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const toExclusive = new Date(toBase.getTime() + 24 * 60 * 60 * 1000);
  const overdueReference = toBase.getTime() < now.getTime() ? new Date(toBase.getTime() + 24 * 60 * 60 * 1000 - 1) : now;

  const [effort, tasks, memberships] = await Promise.all([
    prisma.effortLog.aggregate({
      where: { userId, workDate: { gte: from, lt: toExclusive }, projectId: { not: null } },
      _sum: { actualMinutes: true, minutes: true },
      _count: { _all: true },
    }),
    prisma.projectTask.findMany({
      where: {
        assigneeId: userId,
        OR: [
          { createdAt: { gte: from, lt: toExclusive } },
          { dueDate: { gte: from, lt: toExclusive } },
          { completedAt: { gte: from, lt: toExclusive } },
          { status: { in: ['IN_PROGRESS', 'BLOCKED'] } },
        ],
      },
      select: { id: true, title: true, status: true, dueDate: true, completedAt: true, difficulty: true, plannedMinutes: true, project: { select: { id: true, code: true, name: true } } },
    }),
    prisma.projectMember.findMany({ where: { userId }, select: { projectId: true, project: { select: { code: true, name: true, status: true } } } }),
  ]);

  const done = tasks.filter((t) => t.status === 'DONE');
  const overdue = tasks.filter((t) => t.status !== 'DONE' && t.dueDate && t.dueDate < overdueReference);
  const avgDifficulty = tasks.length ? tasks.reduce((sum, t) => sum + t.difficulty, 0) / tasks.length : 0;

  return res.json({
    success: true,
    data: {
      from: dateOnly(from),
      to: dateOnly(toBase),
      // 사용자 요청사항 4 — 점수/순위는 만들지 않는다. 아래는 전부 객관적 원본 수치다.
      projectCount: memberships.length,
      projects: memberships.map((m) => ({ id: m.projectId, code: m.project.code, name: m.project.name, status: m.project.status })),
      actualMinutes: Number(effort._sum.actualMinutes ?? effort._sum.minutes ?? 0),
      effortEntryCount: effort._count._all,
      assignedTasks: tasks.length,
      completedTasks: done.length,
      overdueTasks: overdue.length,
      blockedTasks: tasks.filter((t) => t.status === 'BLOCKED').length,
      plannedTaskMinutes: tasks.reduce((sum, t) => sum + (t.plannedMinutes ?? 0), 0),
      averageTaskDifficulty: Math.round(avgDifficulty * 10) / 10,
      completionRate: tasks.length ? Math.round((done.length / tasks.length) * 1000) / 10 : null,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: dateOnly(t.dueDate), completedAt: t.completedAt, difficulty: t.difficulty, plannedMinutes: t.plannedMinutes, project: t.project })),
    },
  });
});

/** 관리자/팀장용 전체 직원 성과 요약 — '점수/순위'를 계산하지 않고 원본 근거 수치만 보여준다. */
projectsRouter.get('/performance/summary', requireRole(...adminRoles), async (req, res) => {
  const query = z.object({ from: z.string().optional(), to: z.string().optional() }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '기간을 확인하세요.' } });
  const now = new Date();
  const from = query.data.from ? asDate(query.data.from)! : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const toBase = query.data.to ? asDate(query.data.to)! : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const toExclusive = new Date(toBase.getTime() + 24 * 60 * 60 * 1000);

  const members = await prisma.projectMember.findMany({
    where: { user: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } } },
    include: { user: { select: { id: true, name: true, employeeNo: true, department: { select: { name: true } } } } },
    distinct: ['userId'],
  });
  const userIds = members.map((m) => m.userId);
  const [efforts, tasks, memberships] = await Promise.all([
    prisma.effortLog.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, workDate: { gte: from, lt: toExclusive }, projectId: { not: null } },
      _sum: { actualMinutes: true, minutes: true },
      _count: { _all: true },
    }),
    prisma.projectTask.findMany({
      where: {
        assigneeId: { in: userIds },
        OR: [
          { createdAt: { gte: from, lt: toExclusive } },
          { dueDate: { gte: from, lt: toExclusive } },
          { completedAt: { gte: from, lt: toExclusive } },
          { status: { in: ['IN_PROGRESS', 'BLOCKED'] } },
        ],
      },
      select: { assigneeId: true, status: true, dueDate: true, completedAt: true, difficulty: true, plannedMinutes: true, projectId: true },
    }),
    prisma.projectMember.findMany({ where: { userId: { in: userIds } }, select: { userId: true, projectId: true, allocationPct: true } }),
  ]);

  const effortByUser = new Map(efforts.map((e) => [e.userId, e]));
  const rows = members.map((m) => {
    const e = effortByUser.get(m.userId);
    const userTasks = tasks.filter((t) => t.assigneeId === m.userId);
    const done = userTasks.filter((t) => t.status === 'DONE');
    const overdueReference = toBase.getTime() < now.getTime() ? new Date(toBase.getTime() + 24 * 60 * 60 * 1000 - 1) : now;
    const overdue = userTasks.filter((t) => t.status !== 'DONE' && t.dueDate && t.dueDate < overdueReference);
    const projectCount = new Set(memberships.filter((x) => x.userId === m.userId).map((x) => x.projectId)).size;
    const actualMinutes = Number(e?._sum.actualMinutes ?? e?._sum.minutes ?? 0);
    const plannedMinutes = userTasks.reduce((sum, t) => sum + (t.plannedMinutes ?? 0), 0);
    const avgDifficulty = userTasks.length ? userTasks.reduce((sum, t) => sum + t.difficulty, 0) / userTasks.length : 0;
    return {
      userId: m.user.id,
      employeeNo: m.user.employeeNo,
      name: m.user.name,
      department: m.user.department.name,
      projectCount,
      actualMinutes,
      effortEntryCount: e?._count._all ?? 0,
      assignedTasks: userTasks.length,
      completedTasks: done.length,
      overdueTasks: overdue.length,
      blockedTasks: userTasks.filter((t) => t.status === 'BLOCKED').length,
      plannedTaskMinutes: plannedMinutes,
      averageTaskDifficulty: Math.round(avgDifficulty * 10) / 10,
      completionRate: userTasks.length ? Math.round((done.length / userTasks.length) * 1000) / 10 : null,
    };
  });
  return res.json({ success: true, data: { from: dateOnly(from), to: dateOnly(toBase), rows } });
});

// 2026-10-08: 공수 데이터로 프로젝트 자동 생성(미리보기/적용) — 관리자 전용.
registerBackfillRoutes(projectsRouter);
// 2026-10-08: 프로젝트 상세 통합 화면용 조회(요약/공수 이력/업무일지) — 읽기 전용.
registerProjectInsightRoutes(projectsRouter);

/** 프로젝트 상세 — 참여자/Task/실공수를 한 화면에 쓰기 위한 데이터. */
projectsRouter.get('/:id', requireRole(...adminRoles), async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      client: true,
      manager: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, name: true, department: { select: { name: true } } } } }, orderBy: { joinedAt: 'asc' } },
      tasks: { include: { assignee: { select: { id: true, name: true } }, effortLogs: { select: { actualMinutes: true, minutes: true } } }, orderBy: [{ status: 'asc' }, { dueDate: 'asc' }] },
    },
  });
  if (!project) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' } });
  return res.json({ success: true, data: project });
});
