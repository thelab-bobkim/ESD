import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma';

export interface AuthUser {
  userId: string;
  roles: string[]; // RoleCode[]
  departmentId: string;
  // 2026-08-30 보안점검: 이 토큰이 발급된 시점의 User.tokenVersion 스냅샷. requireAuth가 매 요청마다
  // DB의 현재 tokenVersion과 비교해서, 비밀번호 변경 이후 발급된 토큰이 아니면 거부한다(토큰 폐기 수단).
  tokenVersion: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

/**
 * 2026-09-30 수정(Critical): 예전엔 `process.env.JWT_SECRET || 'CONFIGURABLE_change_me_in_env'`
 * 였다 — 그 기본값은 이 저장소에 그대로 커밋돼 있어서, 환경변수가 주입되지 않은 상태로 기동되는
 * 경로(운영 compose가 아닌 직접 실행, 다른 스크립트, .env.prod 미적용 등)에서는 누구나 그 공개된
 * 문자열로 임의 사용자(예: SYSTEM_ADMIN)의 토큰을 위조해 서명을 통과시킬 수 있었다.
 * 이제 값이 없거나 그 알려진 기본값이면 아예 기동을 실패시킨다(fail-fast).
 * 로컬 개발/테스트도 JWT_SECRET을 반드시 설정해야 한다.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret === 'CONFIGURABLE_change_me_in_env') {
    throw new Error(
      'JWT_SECRET 환경변수가 설정되지 않았습니다(또는 예시 기본값 그대로입니다). .env.prod에 충분히 긴 임의 문자열을 설정한 뒤 다시 기동하세요.'
    );
  }
  return secret;
}

const JWT_SECRET = resolveJwtSecret();

export function signAccessToken(payload: AuthUser): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * 2026-10-01 보안수정(신규-1, 3차 교차검증에서 발견): app.ts의 전역 rate limit이 버킷 키를 고를 때
 * 이전에는 jwt.decode()로 "서명 검증 없이" userId를 읽었다 — UUID 형식만 맞으면 무엇이든 받아들여서,
 * 비밀키를 전혀 몰라도 Authorization 헤더에 아무 UUID나 넣은 위조 토큰이 "로그인한 사용자" 몫인
 * 600회/분 버킷을 새로 받을 수 있었다. 그 UUID를 요청마다 바꾸면 버킷이 계속 새로 생겨, 원래
 * 있어야 할 IP당 300회/분 전역 한도가 사실상 무력화된다(직접 재현: PoC에서 동일 IP로 1분간
 * 3,000회 요청을 전부 200으로 통과시킴 — 가짜 UUID 30종을 번갈아 사용).
 *
 * 이제 서명까지 실제로 검증한다(jwt.verify). 서명이 틀리면(즉 위조 토큰이면) null을 돌려주고,
 * 호출부(app.ts)가 IP 기준 키로 폴백해 익명과 동일한 300회/분 제한을 받게 한다. 여기서 실패해도
 * 요청 자체를 막지는 않는다 — 그건 각 라우터의 requireAuth가 할 일이고, 이 함수는 오직 "버킷을
 * 고르는 용도로 이 토큰의 userId를 신뢰해도 되는가"만 판정한다.
 */
export function tryGetVerifiedUserIdForRateLimit(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId?: unknown };
    return typeof decoded?.userId === 'string' ? decoded.userId : null;
  } catch {
    return null;
  }
}

/**
 * 2026-09-20: "감사인 전용 로그인"(대표이사 요청) — 아이디+비번 확인과 OTP 코드 확인 사이의
 * 짧은 중간 상태를 서버에 아무것도 저장하지 않고 표현하기 위한 용도. 서명된 토큰 자체가
 * "이 사람이 방금 비번까지는 맞혔다"는 증거이고, 5분 안에 OTP까지 맞혀야 실제 접근 토큰
 * (signAccessToken)으로 교환된다. purpose가 'AUDIT_ENROLL'일 때만 secret을 담는데, 이는
 * 아직 DB에 저장하지 않은 새 TOTP 비밀키를 임시로 실어나르기 위함이다(코드 확인에 성공해야
 * 비로소 DB에 저장됨 — auth.routes.ts의 /audit-login/enroll-confirm 참고).
 */
export interface AuditPendingPayload {
  userId: string;
  purpose: 'AUDIT_ENROLL' | 'AUDIT_VERIFY';
  secret?: string;
}

// mustChangePassword 상태에서도 허용하는 경로 — 비밀번호 변경 자체와, 그 화면이 동작하는 데
// 필요한 최소 조회/동의 API만 포함한다(그 외 모든 API는 403 PASSWORD_CHANGE_REQUIRED).
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/location-consent',
  '/api/v1/auth/privacy-consent',
]);

/** 쿼리스트링을 떼고 경로만 남긴다(allowlist 비교용). */
function normalizePath(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

const AUDIT_PENDING_EXPIRES_IN = '5m';

export function signAuditPendingToken(payload: AuditPendingPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: AUDIT_PENDING_EXPIRES_IN });
}

/** 서명/만료/purpose를 모두 확인한다. 하나라도 안 맞으면 null(호출하는 쪽에서 401 처리). */
export function verifyAuditPendingToken(token: string): AuditPendingPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuditPendingPayload;
    if (decoded.purpose !== 'AUDIT_ENROLL' && decoded.purpose !== 'AUDIT_VERIFY') return null;
    if (!decoded.userId) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * 로그인 필수 미들웨어. 서명/만료 검증뿐 아니라, 토큰 속 tokenVersion이 DB의 현재 값과 같은지도
 * 매 요청마다 확인한다 — 비밀번호를 바꾸면 서버가 tokenVersion을 올리므로, 그 이전에 발급된 토큰은
 * 만료 전이라도 여기서 즉시 막힌다(2026-08-30 보안점검, JWT 자체엔 폐기 기능이 없어서 추가).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } });
  }
  const token = header.substring('Bearer '.length);
  let decoded: AuthUser;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '토큰이 유효하지 않습니다.' } });
  }
  // 2026-09-30 수정: 이 함수는 router.use()로 등록되는 미들웨어라 createRouter()의 async 래핑
  // 대상이 아니다 — DB 조회가 실패하면 그대로 unhandled rejection이 되어(Express 4는 async
  // 미들웨어의 rejection을 처리하지 않는다) Node 20에서 프로세스가 종료된다. 자체적으로 잡아
  // 공통 에러 핸들러(next(err) → 500)로 넘긴다.
  try {
    // 2026-09-30 수정(High): 재직 여부도 함께 확인한다 — 예전엔 토큰 서명과 tokenVersion만 봐서,
    // 다우오피스 동기화로 TERMINATED 처리된 퇴사자도 계속 로그인·API 호출이 가능했다
    // (includedInBoard는 상황판 "표시" 여부일 뿐 인증/인가와 무관하다).
    const current = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { tokenVersion: true, employmentStatus: true, mustChangePassword: true },
    });
    // 구버전 토큰(tokenVersion 필드 도입 전 발급분) 호환: 필드가 아예 없으면 이 검사만 건너뛴다.
    if (!current) {
      return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: '사용자를 찾을 수 없습니다. 다시 로그인해주세요.' } });
    }
    // 2026-09-30 수정(L-7): 예전엔 tokenVersion 필드가 없는 구버전 토큰은 이 검사를 건너뛰어, 비밀번호를
    // 바꿔도 그 토큰은 폐기되지 않았다. 필드가 도입된 지(2026-08-30) 토큰 유효기간(7일)이 훨씬 지나
    // 정상 사용자에게 그런 토큰은 남아있지 않으므로, 이제 필드가 없으면 거부한다.
    if (typeof decoded.tokenVersion !== 'number' || current.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: '비밀번호가 변경되어 다시 로그인해야 합니다.' } });
    }
    if (current.employmentStatus !== 'ACTIVE') {
      return res.status(401).json({ success: false, error: { code: 'ACCOUNT_INACTIVE', message: '재직 상태가 아닌 계정입니다. 관리자에게 문의해주세요.' } });
    }
    // 2026-09-30 수정(Medium): mustChangePassword(초기 임시비밀번호) 상태를 서버에서도 강제한다 —
    // 예전엔 프론트가 /change-password로 보내줄 뿐 서버는 다른 API 호출을 전혀 막지 않아서,
    // 리다이렉트를 무시하고 API를 직접 호출하면 그대로 사용할 수 있었다(동기화 계정은 전원이
    // 동일한 공개 기본 비밀번호를 갖고 있어 위험이 컸다). 비밀번호 변경/동의/조회 API만 허용한다.
    if (current.mustChangePassword && !MUST_CHANGE_PASSWORD_ALLOWED_PATHS.has(normalizePath(req.originalUrl))) {
      return res.status(403).json({
        success: false,
        error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '임시 비밀번호 상태입니다. 비밀번호를 먼저 변경해주세요.' },
      });
    }
  } catch (err) {
    return next(err);
  }
  req.authUser = decoded;
  next();
}

/** 역할 기반 접근 제어: 지정한 역할 중 하나라도 있으면 통과 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authUser = req.authUser;
    if (!authUser) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } });
    }
    const hasRole = authUser.roles.some((r) => roles.includes(r));
    if (!hasRole) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '권한이 없습니다.' } });
    }
    next();
  };
}
