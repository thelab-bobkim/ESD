import webpush from 'web-push';
import { prisma } from './prisma';

let configured = false;

function ensureConfigured() {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (publicKey && privateKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  }
}

export function isPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/** 특정 사용자에게 등록된 모든 기기로 푸시 알림을 보낸다. 만료된 구독은 자동 정리한다. */
export async function sendPushToUser(userId: string, payload: { title: string; body: string; url?: string }) {
  if (!isPushConfigured()) return;
  ensureConfigured();

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (err: any) {
      // 구독이 만료/취소된 경우(410 Gone, 404) DB에서 정리한다.
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        // eslint-disable-next-line no-console
        console.warn('[Push] 발송 실패:', err?.message || err);
      }
    }
  }
}
