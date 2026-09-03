import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { isPushConfigured } from '../../common/push';

export const pushRouter = Router();
pushRouter.use(requireAuth);

/** 프론트엔드가 구독을 만들 때 필요한 VAPID 공개키 */
pushRouter.get('/vapid-public-key', (_req, res) => {
  return res.json({
    success: true,
    data: { publicKey: process.env.VAPID_PUBLIC_KEY || null, configured: isPushConfigured() },
  });
});

const subscribeSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

pushRouter.post('/subscribe', async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '구독 정보를 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const { endpoint, keys } = parsed.data;

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });

  return res.json({ success: true, data: { subscribed: true } });
});

const unsubscribeSchema = z.object({ endpoint: z.string().min(1) });

pushRouter.post('/unsubscribe', async (req, res) => {
  const parsed = unsubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'endpoint가 필요합니다.' } });
  }
  await prisma.pushSubscription.deleteMany({ where: { endpoint: parsed.data.endpoint } });
  return res.json({ success: true, data: { unsubscribed: true } });
});

/**
 * 알림 미설정 직원 현황(관리자 전용) — 출퇴근 리마인드가 완전 옵트인이라, 실제로 몇 명이나
 * 켜뒀는지 관리자가 확인할 방법이 지금까지 전혀 없었다. HR이 직접 챙길 수 있게 재직중인
 * 직원 전원과 각자의 구독 여부를 반환한다(2026-09-03 추가 — 사용자 확인 완료).
 */
pushRouter.get('/admin/status', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
    select: { id: true, name: true, department: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  const subs = await prisma.pushSubscription.findMany({ select: { userId: true } });
  const subscribedIds = new Set(subs.map((s: { userId: string }) => s.userId));
  const data = users.map((u: { id: string; name: string; department: { name: string } }) => ({
    userId: u.id,
    name: u.name,
    department: u.department.name,
    subscribed: subscribedIds.has(u.id),
  }));
  return res.json({ success: true, data });
});
