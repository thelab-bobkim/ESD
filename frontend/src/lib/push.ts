import { apiFetch } from './api';

// 2026-09-04: "아이폰에서 알림 켜기가 안 된다"는 문의 — 원인은 iOS Safari의 정책 제약이다.
// 애플은 웹푸시를 "홈 화면에 추가해서 아이콘으로 실행한 앱(standalone)"에서만 허용하고, 일반
// 사파리 탭에서는 PushManager 자체를 지원하지 않는다(브라우저 문제가 아니라 iOS 정책). 방법이
// 없는 게 아니라 "홈 화면에 추가 후 그 아이콘으로 열어야 한다"는 게 유일한 방법이라, 최소한
// 에러 메시지에서라도 그걸 안내하도록 아래 두 헬퍼를 추가했다(InstallBanner.tsx와 동일한 판별 로직).
export function isIOSDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export async function isPushSubscribed(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return Boolean(sub);
}

export async function subscribeToPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (isIOSDevice() && !isStandalonePWA()) {
      throw new Error(
        '아이폰(사파리)에서는 일반 화면에서 알림을 켤 수 없어요 — 애플 정책상 홈 화면에 추가한 앱에서만 가능합니다. 하단 공유 버튼(⬆️) → "홈 화면에 추가"를 누른 뒤, 그 아이콘으로 다시 열어서 켜주세요.'
      );
    }
    throw new Error('이 브라우저는 푸시 알림을 지원하지 않습니다.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('알림 권한이 허용되지 않았습니다.');
  }
  const { publicKey, configured } = await apiFetch<{ publicKey: string | null; configured: boolean }>('/push/vapid-public-key');
  if (!configured || !publicKey) {
    throw new Error('서버에 알림 기능이 아직 설정되지 않았습니다.');
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  await apiFetch('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await apiFetch('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
}
