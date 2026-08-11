import { Router } from 'express';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'));

/** 사용자별 "가장 최근" 상태 변경 로그를 모아 상황판을 만든다 (간단한 MVP 집계 방식). */
async function buildStatusBoard(userIds?: string[]) {
  const users = await prisma.user.findMany({
    where: userIds ? { id: { in: userIds } } : undefined,
    include: { department: true, assignedClient: true },
  });

  const board = await Promise.all(
    users.map(async (u) => {
      const latestStatus = await prisma.statusChangeLog.findFirst({ where: { userId: u.id }, orderBy: { changedAt: 'desc' } });
      const latestCheckin = await prisma.residentCheckin.findFirst({ where: { userId: u.id }, orderBy: { checkinAt: 'desc' } });
      return {
        userId: u.id,
        name: u.name,
        department: u.department.name,
        client: u.assignedClient?.name ?? null,
        workType: u.workType,
        status: latestStatus?.status ?? null,
        statusChangedAt: latestStatus?.changedAt ?? null,
        statusSource: latestStatus?.source ?? null,
        statusNote: latestStatus?.note ?? null,
        lastConfirmedAt: latestCheckin?.lastConfirmedAt ?? null,
      };
    })
  );
  return board;
}

dashboardRouter.get('/company', async (req, res) => {
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
