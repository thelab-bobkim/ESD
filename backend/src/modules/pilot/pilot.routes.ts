import { createRouter } from '../../common/async-router';
import { takeWithTruncation, setTruncationHeaders } from '../../common/list-limit';

const PILOT_FEEDBACK_LIST_LIMIT = 300;
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { sendPushToUser } from '../../common/push';

export const pilotRouter = createRouter();

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
  const fetched = await prisma.pilotFeedback.findMany({
    include: {
      user: { select: { name: true, employeeNo: true } },
      resolvedBy: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    // 2026-09-30(M-3): 1건 더 조회해 잘림 여부를 판정하고 헤더로 알린다.
    take: PILOT_FEEDBACK_LIST_LIMIT + 1,
  });
  const { rows: feedback, truncated } = takeWithTruncation(fetched, PILOT_FEEDBACK_LIST_LIMIT);
  setTruncationHeaders(res, truncated, PILOT_FEEDBACK_LIST_LIMIT);
  return res.json({ success: true, data: feedback });
});

/**
 * 2026-09-14: 관리자 피드백함에서 조치 완료된 항목을 따로 표시해달라는 요청 — 누르면 처리완료로
 * 표시(resolvedAt/resolvedByUserId 기록), 다시 누르면 미처리로 되돌릴 수 있게 토글로 만든다
 * (실수로 눌렀을 때 되돌릴 방법이 없으면 곤란하므로).
 */
const resolveSchema = z.object({ resolved: z.boolean() });

pilotRouter.patch('/feedback/:id/resolve', requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'), async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const actorUserId = req.authUser!.userId;
  const existing = await prisma.pilotFeedback.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '피드백을 찾을 수 없습니다.' } });
  }
  const updated = await prisma.pilotFeedback.update({
    where: { id: req.params.id },
    data: parsed.data.resolved
      ? { resolvedAt: new Date(), resolvedByUserId: actorUserId }
      : { resolvedAt: null, resolvedByUserId: null },
    include: { user: { select: { name: true, employeeNo: true } }, resolvedBy: { select: { name: true } } },
  });

  /**
   * 2026-09-16: "미처리 -> 처리완료"로 새로 전환되는 순간, 기존 관리자↔직원 양방향 메시지 기능
   * (messages.routes.ts/AdminMessage — 상황판 아바타 클릭 메시지와 동일한 테이블·푸시 경로)을 그대로
   * 재사용해 작성자에게 처리완료 사실을 안내한다. 문자(SMS) 발송 요청이었으나, 이미 배포돼 있는
   * 이 인앱 메시지 기능이 그대로 요구사항을 충족해서 재사용했다(요청자 확인, 2026-09-16).
   * 미처리로 되돌렸다가 다시 처리완료로 바꾸는 경우까지 매번 알리면 스팸처럼 느껴질 수 있어,
   * "새로 전환되는 순간"(existing.resolvedAt이 null이었던 경우)에만 1회 보낸다.
   */
  if (parsed.data.resolved && !existing.resolvedAt) {
    const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { name: true } });
    const preview = existing.content.length > 60 ? `${existing.content.slice(0, 60)}...` : existing.content;
    const notice = `[피드백 처리완료] 남겨주신 의견이 처리되었습니다.\n"${preview}"`;
    await prisma.adminMessage.create({
      data: { userId: existing.userId, message: notice, senderIsAdmin: true, sentByName: actor?.name ?? '관리자' },
    });
    await sendPushToUser(existing.userId, { title: '📨 피드백 처리완료', body: notice, url: '/' }).catch(() => {});
  }

  return res.json({ success: true, data: updated });
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
