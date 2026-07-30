/**
 * API 베이스 URL 결정 규칙:
 * 1) 빌드 시 NEXT_PUBLIC_API_BASE_URL이 명시되어 있으면 그 값을 사용한다.
 * 2) 그렇지 않으면(운영 서버에서 nginx가 "/api/"를 백엔드로 프록시하는 구조를 전제로)
 *    브라우저가 접속한 origin 기준 상대경로("/api/v1")를 사용한다.
 *    이렇게 하면 Lightsail 공용 IP가 바뀌거나 도메인이 나중에 붙어도 재빌드 없이 동작한다.
 */
function resolveApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_BASE_URL) return process.env.NEXT_PUBLIC_API_BASE_URL;
  if (typeof window !== 'undefined') return `${window.location.origin}/api/v1`;
  return 'http://localhost:4000/api/v1'; // 서버사이드 렌더링 시 fallback (MVP 화면은 대부분 클라이언트 렌더링)
}

const API_BASE = resolveApiBase();

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('accessToken');
}

export function setToken(token: string) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('accessToken', token);
  }
}

export function clearToken() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('accessToken');
  }
}

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json?.error?.message || '요청 처리 중 오류가 발생했습니다.');
  }
  return json.data as T;
}
