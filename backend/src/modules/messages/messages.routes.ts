import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { sendPushToUser } from '../../common/push';

/**
 * 관리자 → 직원 간단 메시지. 상황판(dashboard.tsx)에서 위치 불일치/미확인 등으로 표시된 직원의
 * 아바타를 눌러 짧은 메시지를 보내면, 등록된 푸시 구독으로 즉시 알리고(sendPushToUser 재사용),
 * 직원이 앱(index.tsx)에 접속하면 안 읽은 메시지를 배너로도 보여준다.
 */
export const messagesRouter = Router();
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
    data: { userId, message, sentByName: sender?.name ?? '관리자' },
  });

  // 푸시 발송은 실패해도(미구독 등) 메시지 자체는 이미 저장됐으니 등록 실패로 처리하지 않는다.
  await sendPushToUser(userId, {
    title: `📨 ${sender?.name ?? '관리자'}님의 메시지`,
    body: message,
    url: '/',
  }).catch(() => {});

  return res.json({ success: true, data: { id: created.id, sentTo: target.name } });
});

/** 본인 앞으로 온, 아직 안 읽은 메시지 목록(오래된 순) */
messagesRouter.get('/unread', async (req, res) => {
  const userId = req.authUser!.userId;
  const rows = await prisma.adminMessage.findMany({
    where: { userId, readAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({
    success: true,
    data: rows.map((r) => ({ id: r.id, message: r.message, sentByName: r.sentByName, createdAt: r.createdAt })),
  });
});

/** 메시지 확인 처리(본인 것만) */
messagesRouter.post('/:id/read', async (req, res) => {
  const userId = req.authUser!.userId;
  const existing = await prisma.adminMessage.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== userId) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '메시지를 찾을 수 없습니다.' } });
  }
  if (!existing.readAt) {
    await prisma.adminMessage.update({ where: { id: req.params.id }, data: { readAt: new Date() } });
  }
  return res.json({ success: true, data: { read: true } });
});
