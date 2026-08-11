// 최소한의 서비스워커 — 오프라인 캐싱은 하지 않고, PWA 설치 가능 조건(fetch 핸들러 존재)만 충족시킨다.
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
