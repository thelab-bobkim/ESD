import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
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
