import { createRouter } from '../../common/async-router';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { sendPushToUser } from '../../common/push';

/**
 * 관리자 ↔ 직원 간 짧은 메시지(양방향). 상황판(dashboard.tsx)에서 위치 불일치/미확인 등으로
 * 표시된 직원의 아바타를 눌러 짧은 메시지를 보내면, 등록된 푸시 구독으로 즉시 알리고
 * (sendPushToUser 재사용), 직원이 앱(index.tsx)에 접속하면 안 읽은 메시지를 배너로도 보여준다.
 * 2026-09-15: 직원도 그 배너에서 바로 답장할 수 있게 확장 — 답장은 관리자 쪽에 푸시로 알리지
 * 않고(관리자 전용 푸시 타겟팅이 아직 없음), 상황판이 15초마다 자동 갱신되는 걸 활용해
 * "새 답장" 카운트로 보여준다(admin/unread-summary).
 */
export const messagesRouter = createRouter();
messagesRouter.use(requireAuth);

const sendMessageSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().trim().min(1, '메시지 내용을 입력해주세요.').max(500, '메시지는 500자 이내로 입력해주세요.'),
});

/** 관리자가 특정 직원에게 메시지 발송 */
messagesRouter.post('/admin', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const { userId, message } = parsed.data;

  const [target, sender] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } }),
    prisma.user.findUnique({ where: { id: req.authUser!.userId }, select: { name: true } }),
  ]);
  if (!target) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '대상 직원을 찾을 수 없습니다.' } });
  }

  const created = await prisma.adminMessage.create({
    data: { userId, message, senderIsAdmin: true, sentByName: sender?.name ?? '관리자' },
  });

  // 푸시 발송은 실패해도(미구독 등) 메시지 자체는 이미 저장됐으니 등록 실패로 처리하지 않는다.
  await sendPushToUser(userId, {
    title: `📨 ${sender?.name ?? '관리자'}님의 메시지`,
    body: message,
    url: '/',
  }).catch(() => {});

  return res.json({ success: true, data: { id: created.id, sentTo: target.name } });
});

const replySchema = z.object({
  message: z.string().trim().min(1, '메시지 내용을 입력해주세요.').max(500, '메시지는 500자 이내로 입력해주세요.'),
});

/** 직원이 관리자 메시지에 답장 */
messagesRouter.post('/reply', async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const userId = req.authUser!.userId;
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

  const created = await prisma.adminMessage.create({
    data: { userId, message: parsed.data.message, senderIsAdmin: false, sentByName: me?.name ?? '직원' },
  });
  return res.json({ success: true, data: { id: created.id } });
});

/** 본인 앞으로 온(관리자가 보낸), 아직 안 읽은 메시지 목록(오래된 순) */
messagesRouter.get('/unread', async (req, res) => {
  const userId = req.authUser!.userId;
  const rows = await prisma.adminMessage.findMany({
    where: { userId, senderIsAdmin: true, readAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({
    success: true,
    data: rows.map((r) => ({ id: r.id, message: r.message, sentByName: r.sentByName, createdAt: r.createdAt })),
  });
});

/** 메시지 확인 처리(본인이 받은 관리자 메시지만) */
messagesRouter.post('/:id/read', async (req, res) => {
  const userId = req.authUser!.userId;
  const existing = await prisma.adminMessage.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== userId || !existing.senderIsAdmin) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '메시지를 찾을 수 없습니다.' } });
  }
  if (!existing.readAt) {
    await prisma.adminMessage.update({ where: { id: req.params.id }, data: { readAt: new Date() } });
  }
  return res.json({ success: true, data: { read: true } });
});

/** 관리자 전용 — 아직 안 읽은 직원 답장을 보낸 사람 기준으로 묶어서 보여준다(상황판 알림용). */
messagesRouter.get('/admin/unread-summary', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (_req, res) => {
  const rows = await prisma.adminMessage.findMany({
    where: { senderIsAdmin: false, readAt: null },
    include: { user: { select: { name: true, department: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  const byUser = new Map<
    string,
    { userId: string; name: string; department: string; lastMessage: string; lastMessageAt: Date; unreadCount: number }
  >();
  for (const r of rows) {
    const existing = byUser.get(r.userId);
    if (existing) {
      existing.unreadCount += 1;
    } else {
      byUser.set(r.userId, {
        userId: r.userId,
        name: r.user.name,
        department: r.user.department.name,
        lastMessage: r.message,
        lastMessageAt: r.createdAt,
        unreadCount: 1,
      });
    }
  }
  return res.json({ success: true, data: Array.from(byUser.values()) });
});

/**
 * 관리자 전용 — "메시지함" 목록. 기존 admin/unread-summary는 안 읽은 답장이 있는 직원만
 * 보여줘서(상황판 알림용) 이미 확인한 대화나 관리자가 먼저 보내기만 하고 아직 답장이 없는
 * 대화는 빠졌었다. 2026-09-16: 별도 "메시지함" 메뉴를 만들면서, 주고받은 이력이 있는 모든
 * 직원을 최근 순으로 보여주는 용도로 추가 — unreadCount는 그중 관리자가 아직 안 읽은
 * 직원 답장 개수(0일 수 있음).
 */
messagesRouter.get('/admin/conversations', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (_req, res) => {
  // 2026-09-30 수정(M-3): 예전엔 전체 메시지를 상한 없이 전부 불러와 메모리에서 대화별로 묶었다 —
  // 메시지는 계속 쌓이기만 하므로(20초 폴링 화면) 시간이 갈수록 무한히 무거워졌다. 이제
  // (1) 사용자별 최신 메시지 1건(DISTINCT ON), (2) 사용자별 안 읽은 답장 수(groupBy) 두 쿼리로 끝낸다.
  // 응답 형태와 정렬(최근 대화순)은 기존과 동일하다.
  const [latestPerUser, unreadGroups] = await Promise.all([
    prisma.adminMessage.findMany({
      distinct: ['userId'],
      orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
      include: { user: { select: { name: true, employeeNo: true, department: { select: { name: true } } } } },
    }),
    prisma.adminMessage.groupBy({
      by: ['userId'],
      where: { senderIsAdmin: false, readAt: null },
      _count: { _all: true },
    }),
  ]);
  const unreadByUser = new Map(unreadGroups.map((g) => [g.userId, g._count._all] as const));
  const rows = [...latestPerUser].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const byUser = new Map<
    string,
    {
      userId: string;
      name: string;
      employeeNo: string;
      department: string;
      lastMessage: string;
      lastMessageAt: Date;
      lastMessageFromAdmin: boolean;
      unreadCount: number;
    }
  >();
  for (const r of rows) {
    byUser.set(r.userId, {
      userId: r.userId,
      name: r.user.name,
      employeeNo: r.user.employeeNo,
      department: r.user.department.name,
      lastMessage: r.message,
      lastMessageAt: r.createdAt,
      lastMessageFromAdmin: r.senderIsAdmin,
      unreadCount: unreadByUser.get(r.userId) ?? 0,
    });
  }
  return res.json({ success: true, data: Array.from(byUser.values()) });
});

/**
 * 관리자 전용 — 특정 직원과 주고받은 메시지 전체(오래된 순). 조회하는 순간 그 직원이 보낸
 * 안 읽은 답장을 전부 읽음 처리한다(이 화면 자체가 관리자의 받은함 역할이라 별도 확인 버튼을
 * 두지 않았다).
 */
messagesRouter.get('/thread/:userId', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  const targetUserId = req.params.userId;
  const rows = await prisma.adminMessage.findMany({
    where: { userId: targetUserId },
    orderBy: { createdAt: 'asc' },
  });
  await prisma.adminMessage.updateMany({
    where: { userId: targetUserId, senderIsAdmin: false, readAt: null },
    data: { readAt: new Date() },
  });
  return res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      message: r.message,
      senderIsAdmin: r.senderIsAdmin,
      sentByName: r.sentByName,
      createdAt: r.createdAt,
    })),
  });
});
