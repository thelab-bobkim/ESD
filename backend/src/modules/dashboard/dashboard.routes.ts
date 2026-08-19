import { Router } from 'express';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'));

/** attendance.routes.ts의 todayDateOnly()와 동일한 "오늘 자정(UTC)" 기준 */
function todayStartUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * 사용자별 "가장 최근" 상태 변경 로그를 모아 상황판을 만든다 (간단한 MVP 집계 방식).
 * 단, 그 상태가 "오늘" 것이 아니면(며칠 지난 옛날 상태) 상황판에는 "상태 미확인"으로 표시한다 —
 * 상황판은 "지금" 뭘 하고 있는지를 보여주는 화면이라, 날짜가 지난 상태를 계속 현재처럼 보여주면 안 된다.
 */
async function buildStatusBoard(userIds?: string[]) {
  const todayStart = todayStartUTC();
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
      const latestStatus = await prisma.statusChangeLog.findFirst({ where: { userId: u.id }, orderBy: { changedAt: 'desc' } });
      const latestCheckin = await prisma.residentCheckin.findFirst({ where: { userId: u.id }, orderBy: { checkinAt: 'desc' } });
      const isToday = latestStatus && latestStatus.changedAt >= todayStart;
      return {
        userId: u.id,
        name: u.name,
        department: u.department.name,
        client: u.assignedClient?.name ?? null,
        workType: u.workType,
        status: isToday ? latestStatus!.status : null,
        statusChangedAt: isToday ? latestStatus!.changedAt : null,
        statusSource: isToday ? latestStatus!.source : null,
        statusNote: isToday ? latestStatus!.note : null,
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
