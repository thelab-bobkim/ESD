import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

export const pilotRouter = Router();

const managerOnly = requireRole('PILOT_MANAGER', 'SYSTEM_ADMIN');

const createGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
});

pilotRouter.post('/groups', requireAuth, managerOnly, async (req, res) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const group = await prisma.pilotGroup.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
    },
  });
  return res.json({ success: true, data: group });
});

const addMembersSchema = z.object({ userIds: z.array(z.string().uuid()).min(1) });

pilotRouter.post('/groups/:id/members', requireAuth, managerOnly, async (req, res) => {
  const parsed = addMembersSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'userIds가 필요합니다.' } });
  }
  const groupId = req.params.id;
  const created = await prisma.$transaction(
    parsed.data.userIds.map((userId) =>
      prisma.pilotGroupMember.upsert({
        where: { pilotGroupId_userId: { pilotGroupId: groupId, userId } },
        update: {},
        create: { pilotGroupId: groupId, userId },
      })
    )
  );
  return res.json({ success: true, data: created });
});

pilotRouter.get('/groups/:id/report', requireAuth, managerOnly, async (req, res) => {
  const groupId = req.params.id;
  const members = await prisma.pilotGroupMember.findMany({ where: { pilotGroupId: groupId }, include: { user: true } });
  const memberIds = members.map((m) => m.userId);

  const [statusLogCount, nightWorkCount, feedbackList] = await Promise.all([
    prisma.statusChangeLog.count({ where: { userId: { in: memberIds } } }),
    prisma.nightWorkSession.count({ where: { userId: { in: memberIds } } }),
    prisma.pilotFeedback.findMany({ where: { pilotGroupId: groupId }, orderBy: { createdAt: 'desc' } }),
  ]);

  return res.json({
    success: true,
    data: {
      memberCount: members.length,
      statusChangeCount: statusLogCount,
      nightWorkSessionCount: nightWorkCount,
      feedbackCount: feedbackList.length,
      feedback: feedbackList,
    },
  });
});

const feedbackSchema = z.object({
  pilotGroupId: z.string().uuid(),
  category: z.enum(['BUG', 'UX', 'POLICY', 'OTHER']),
  content: z.string().min(1),
});

pilotRouter.post('/feedback', requireAuth, async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const feedback = await prisma.pilotFeedback.create({
    data: { pilotGroupId: parsed.data.pilotGroupId, userId, category: parsed.data.category, content: parsed.data.content },
  });
  return res.json({ success: true, data: feedback });
});

pilotRouter.get('/stats', requireAuth, managerOnly, async (_req, res) => {
  const groups = await prisma.pilotGroup.findMany({ include: { members: true, feedback: true } });
  const data = groups.map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g.members.length,
    feedbackCount: g.feedback.length,
    startDate: g.startDate,
    endDate: g.endDate,
  }));
  return res.json({ success: true, data });
});
