import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  userId: string;
  roles: string[]; // RoleCode[]
  departmentId: string;
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

/** 로그인 필수 미들웨어 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } });
  }
  const token = header.substring('Bearer '.length);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.authUser = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '토큰이 유효하지 않습니다.' } });
  }
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
