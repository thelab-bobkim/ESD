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
    const err = new Error(json?.error?.message || '요청 처리 중 오류가 발생했습니다.');
    // 서버가 내려준 에러 코드(예: AWAY_FROM_HQ)를 같이 실어 보낸다 — 호출하는 쪽에서 메시지
    // 문자열이 아니라 이 코드로 특정 상황(위치 재시도 등)을 구분해서 처리할 수 있게.
    (err as Error & { code?: string }).code = json?.error?.code;
    throw err;
  }
  return json.data as T;
}

// 2026-09-30 수정: 여러 화면이 "로그인이 필요합니다" 판단을 err.message에 '로그인'/'토큰'/'권한'
// 같은 단어가 들어있는지로 문자열 매칭해왔다 — 그런데 일반적인 403 권한부족 에러(예: "다른 부서의
// 요청은 처리할 권한이 없습니다", approval.routes.ts)도 '권한'이 들어있어서, 그 특정 작업 하나를
// 할 권한이 없을 뿐인데 전체 로그아웃되어 로그인화면으로 튕겨나가는 오탐이 있었다. 서버가 이미
// 실어 보내는 err.code(로그인 자체가 필요한 경우에만 쓰이는 값들)로 정확히 구분한다.
const AUTH_EXPIRED_CODES = new Set(['UNAUTHENTICATED', 'INVALID_TOKEN', 'TOKEN_REVOKED']);
export function isAuthExpiredError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  return Boolean(code && AUTH_EXPIRED_CODES.has(code));
}

/** CSV 등 파일 다운로드 — 일반 JSON 응답이 아니라 브라우저에서 바로 파일로 저장한다(인증 헤더 포함). */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    throw new Error('파일을 받아오지 못했습니다.');
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
