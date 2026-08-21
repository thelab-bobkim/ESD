// 서비스워커 — 오프라인 캐싱은 하지 않고(PWA 설치 가능 조건 + 푸시 알림 수신용).
// 이 시스템은 실시간 데이터가 핵심이라 오프라인 캐싱을 넣지 않는 편이 안전하다(오래된 상태가 보이면 안 되므로).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // 그대로 네트워크로 통과시킨다(캐싱 없음).
  event.respondWith(fetch(event.request));
});

// 오전 9시 미출근 알림 등 서버가 보내는 푸시 메시지를 화면에 띄운다.
self.addEventListener('push', (event) => {
  let payload = { title: 'Tech Status Board', body: '알림이 도착했습니다.', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) {
    // JSON이 아니면 기본값 사용
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url || '/' },
    })
  );
});

// 알림 클릭 시 앱 화면으로 포커스/이동
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
