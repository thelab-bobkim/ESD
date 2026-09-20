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

const JWT_SECRET = process.env.JWT_SECRET || 'CONFIGURABLE_change_me_in_env';

export function signAccessToken(payload: AuthUser): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
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
  // 구버전 토큰(tokenVersion 필드 도입 전 발급분) 호환: 필드가 아예 없으면 검사를 건너뛴다.
  if (typeof decoded.tokenVersion === 'number') {
    const current = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { tokenVersion: true } });
    if (!current || current.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: '비밀번호가 변경되어 다시 로그인해야 합니다.' } });
    }
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
