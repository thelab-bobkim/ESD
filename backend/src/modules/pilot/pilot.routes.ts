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
  pilotGroupId: z.string().uuid().optional(),
  category: z.enum(['BUG', 'UX', 'POLICY', 'OTHER']),
  content: z.string().min(1),
});

/**
 * TSB-Ver3.1: pilotGroupId를 선택값으로 완화 — 정식 파일럿 그룹 멤버(pilot_group_members)로
 * 등록된 인원이 극소수(2명)뿐이라, 대부분의 직원은 groupId를 몰라서 기존 방식대로는 피드백을
 * 아예 남길 수 없었다. 본인이 속한 그룹이 있으면 그걸 쓰고, 없으면 가장 최근 파일럿 그룹으로
 * 자동 귀속시킨다(2026-09-11 개선 제안서 Quick win 반영).
 */
async function resolvePilotGroupId(userId: string): Promise<string | null> {
  const membership = await prisma.pilotGroupMember.findFirst({ where: { userId } });
  if (membership) return membership.pilotGroupId;
  const anyGroup = await prisma.pilotGroup.findFirst({ orderBy: { startDate: 'desc' } });
  return anyGroup?.id ?? null;
}

pilotRouter.post('/feedback', requireAuth, async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const pilotGroupId = parsed.data.pilotGroupId ?? (await resolvePilotGroupId(userId));
  if (!pilotGroupId) {
    return res.status(400).json({ success: false, error: { code: 'NO_PILOT_GROUP', message: '등록된 파일럿 그룹이 없습니다. 관리자에게 문의해주세요.' } });
  }
  const feedback = await prisma.pilotFeedback.create({
    data: { pilotGroupId, userId, category: parsed.data.category, content: parsed.data.content },
  });
  return res.json({ success: true, data: feedback });
});

/**
 * TSB-Ver3.1: 관리자용 전체 피드백 목록 — 기존엔 그룹별 report(/groups/:id/report)나 통계(/stats)만
 * 있고 "그냥 전체 피드백 목록"을 보는 API가 없어서 화면을 만들 수가 없었다. 다른 관리자 화면과
 * 동일한 권한 범위로 열어준다.
 */
pilotRouter.get('/feedback', requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'), async (_req, res) => {
  const feedback = await prisma.pilotFeedback.findMany({
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { createdAt: 'desc' },
    take: 300,
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
