import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { prisma } from '../../common/prisma';
import { requireAuth, signAccessToken, signAuditPendingToken, verifyAuditPendingToken } from '../../common/guards/auth';

export const authRouter = Router();

/**
 * 2026-09-20: "감사인 계정은 따로 빼서"(대표이사 요청) — AUDITOR 역할은 DB(UserRole)에는 남아있어도,
 * 이 파일의 "일반" 토큰 발급 지점(로그인/계정등록/비번재설정)에서는 항상 걸러내고 절대 토큰에
 * 싣지 않는다. 이걸 빼먹으면, 감사인으로 지정된 사람이 그냥 평소처럼 /login으로 로그인하는 것만으로
 * AUDITOR 권한이 실린 토큰을 받아버려서 OTP 2단계 인증(/audit-login) 없이도
 * /audit-location/remote를 호출할 수 있게 되어, "감사인 계정은 따로 빼서" 요청 전체가 무력화된다.
 * AUDITOR가 실제로 실린 토큰은 오직 /audit-login → /audit-login/verify(또는 enroll-confirm)를
 * 통과했을 때만 발급된다(issueAuditAccessToken 참고).
 */
function rolesExcludingAuditor(roles: string[]): string[] {
  return roles.filter((r) => r !== 'AUDITOR');
}

const registerSchema = z.object({
  employeeNo: z.string().min(1),
  name: z.string().min(1),
  newPassword: z.string().min(10, '비밀번호는 10자 이상이어야 합니다.'),
});

/**
 * 최초 계정 등록: 관리자가 임시 비밀번호를 일일이 안 알려줘도, 직원 본인이 사번+이름으로
 * 본인 확인 후 원하는 비밀번호를 직접 설정한다. mustChangePassword=true인 계정만 가능하며,
 * 한 번 설정하면 다시 이 API로는 못 바꾼다(로그인 후 /auth/change-password를 써야 함).
 * 사번+이름은 비밀글이 아니라서 완전한 신원확인은 아니다 — 사내망 대상 파일럿 수준의 가벼운 확인이다.
 */
authRouter.post('/register-password', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const { employeeNo, name, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { employeeNo },
    include: { userRoles: { include: { role: true } } },
  });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사번을 찾을 수 없습니다. 사번을 다시 확인해주세요.' } });
  }
  if (user.name.trim() !== name.trim()) {
    return res.status(401).json({ success: false, error: { code: 'MISMATCH', message: '사번과 이름이 일치하지 않습니다.' } });
  }
  if (!user.mustChangePassword) {
    return res.status(400).json({
      success: false,
      error: { code: 'ALREADY_REGISTERED', message: '이미 비밀번호가 등록된 계정입니다. 로그인 화면에서 로그인해주세요.' },
    });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash, mustChangePassword: false },
  });

  const roles = rolesExcludingAuditor(user.userRoles.map((ur) => ur.role.code));
  const token = signAccessToken({ userId: user.id, roles, departmentId: user.departmentId, tokenVersion: user.tokenVersion });

  return res.json({
    success: true,
    data: {
      accessToken: token,
      user: { id: user.id, name: user.name, email: user.email, employeeNo: user.employeeNo, roles, workType: user.workType, mustChangePassword: false },
    },
  });
});

const resetPasswordSchema = z.object({
  employeeNo: z.string().min(1),
  name: z.string().min(1),
  newPassword: z.string().min(10, '비밀번호는 10자 이상이어야 합니다.'),
});

/**
 * 비밀번호를 잊어버린 직원을 위한 셀프 재설정(2026-09-04 추가 — 사용자 요청: "전 직원이 재설정할
 * 수 있게"). register-password와 신원확인 방식(사번+이름)은 같지만, mustChangePassword 여부와
 * 상관없이 이미 비밀번호를 쓰고 있는 계정도 언제든 다시 쓸 수 있다는 점이 다르다 — 관리자가
 * 매번 서버에 SQL을 날려 mustChangePassword를 되돌려줄 필요 없이 전 직원이 스스로 해결한다.
 *
 * 사번+이름은 비밀글이 아니라서(조직도로 누구나 알 수 있음) 완전한 신원확인은 아니다 — 사내망
 * 전용 파일럿이라는 전제로 register-password 때와 같은 수준의 가벼운 확인을 그대로 채택했다.
 * 대신 재설정이 성공하면 tokenVersion을 올려 기존에 발급된 모든 토큰(다른 기기 포함)을 즉시
 * 무효화한다 — 본인이 아닌 다른 사람이 이름만 알고 몰래 재설정한 경우에도 원래 사용자가 즉시
 * 로그아웃되어 이상 상황을 바로 알아챌 수 있다. 로그인 실패 잠금 상태였다면 이 기회에 함께 풀어준다.
 */
authRouter.post('/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const { employeeNo, name, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { employeeNo },
    include: { userRoles: { include: { role: true } } },
  });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사번을 찾을 수 없습니다. 사번을 다시 확인해주세요.' } });
  }
  if (user.name.trim() !== name.trim()) {
    return res.status(401).json({ success: false, error: { code: 'MISMATCH', message: '사번과 이름이 일치하지 않습니다.' } });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: newHash,
      mustChangePassword: false,
      tokenVersion: { increment: 1 },
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
  // eslint-disable-next-line no-console
  console.log(`[PasswordReset] ${updated.employeeNo}(${updated.name}) 비밀번호 셀프 재설정`);

  const roles = rolesExcludingAuditor(user.userRoles.map((ur: { role: { code: string } }) => ur.role.code));
  const token = signAccessToken({ userId: updated.id, roles, departmentId: updated.departmentId, tokenVersion: updated.tokenVersion });

  return res.json({
    success: true,
    data: {
      accessToken: token,
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        employeeNo: updated.employeeNo,
        roles,
        workType: updated.workType,
        mustChangePassword: false,
      },
    },
  });
});

const loginSchema = z.object({
  // 이메일이 있는 계정은 이메일로, 다우오피스 동기화 계정(이메일 없음)은 사번/다우오피스 로그인ID로 로그인한다.
  identifier: z.string().min(1),
  password: z.string().min(1),
});

// 2026-08-30 보안점검: IP 기준 rate-limit(app.ts)과는 별개로, 계정 단위로도 무차별 대입을 막는다 —
// 여러 IP로 나눠서 시도하는 공격은 IP 제한만으로는 못 막기 때문.
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCK_DURATION_MS = 15 * 60_000;

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const { identifier, password } = parsed.data;

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { employeeNo: identifier }] },
    include: { userRoles: { include: { role: true } } },
  });
  if (!user) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } });
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutesLeft = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
    return res.status(423).json({
      success: false,
      error: { code: 'ACCOUNT_LOCKED', message: `로그인 시도가 너무 많아 계정이 잠겼습니다. ${minutesLeft}분 후 다시 시도해주세요.` },
    });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: shouldLock
        ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS) }
        : { failedLoginAttempts: attempts },
    });
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } });
  }
  // 2026-09-04: "앱을 실제로 쓰는지" 관리자가 확인할 수 있게 로그인 성공 시각을 남긴다
  // (admin/board-scope 화면 참고). 실패 카운터 초기화가 필요 없는 경우에도 이 값은 항상 갱신한다.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      ...(user.failedLoginAttempts > 0 || user.lockedUntil ? { failedLoginAttempts: 0, lockedUntil: null } : {}),
    },
  });

  const roles = rolesExcludingAuditor(user.userRoles.map((ur) => ur.role.code));
  const token = signAccessToken({ userId: user.id, roles, departmentId: user.departmentId, tokenVersion: user.tokenVersion });

  return res.json({
    success: true,
    data: {
      accessToken: token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        employeeNo: user.employeeNo,
        roles,
        workType: user.workType,
        mustChangePassword: user.mustChangePassword,
      },
    },
  });
});

// ── 감사인 전용 로그인(2026-09-20, 대표이사 요청) ──────────────────────────────
//
// HR/유지보수/CFO 등 일반 관리자와 같은 위 /login을 쓰지 않고, "딱 지정된 한 명"의 감사인만
// 이 별도 경로로 로그인한다(프론트도 /admin이 아니라 별도 /audit-login·/audit 페이지를 씀).
// 아이디+비번을 먼저 확인하고, OTP 인증앱(구글 OTP 등) 2단계 인증을 반드시 통과해야 최종
// 접근 토큰이 발급된다. 그 토큰은 이 계정이 실제로 갖고 있는 다른 역할(HR_ADMIN 등)과 무관하게
// roles=['AUDITOR']만 실려서 발급되므로, 이 경로로 로그인한 세션은 감사 화면 API 외에는
// 아무것도 호출할 수 없다(다른 관리자 API는 requireRole이 다른 역할을 요구해서 그대로 403).
//
// 계정 잠금(failedLoginAttempts/lockedUntil)은 위 일반 로그인과 같은 컬럼을 그대로 공유한다 —
// 두 경로 중 어느 쪽이든 5회 이상 틀리면 계정 전체가 15분 잠기는 셈인데, 감사인 계정 하나만
// 걸리는 일이라 오히려 더 보수적으로(안전하게) 동작하는 셈이라 의도적으로 그대로 뒀다.

const auditLoginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

async function findAuditorAccount(identifier: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { employeeNo: identifier }] },
    include: { userRoles: { include: { role: true } } },
  });
  const isAuditor = Boolean(user?.userRoles.some((ur: { role: { code: string } }) => ur.role.code === 'AUDITOR'));
  return { user, isAuditor };
}

authRouter.post('/audit-login', async (req, res) => {
  const parsed = auditLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const { identifier, password } = parsed.data;

  const { user, isAuditor } = await findAuditorAccount(identifier);
  // 계정이 없거나 감사인 권한이 없으면 항상 같은 메시지로 거절한다 — "이 계정엔 감사인 권한이
  // 없다"는 사실 자체가 일반 로그인 실패와 구분되지 않게 하기 위함(권한 유무 자체를 숨김).
  if (!user || !isAuditor) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } });
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutesLeft = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
    return res.status(423).json({
      success: false,
      error: { code: 'ACCOUNT_LOCKED', message: `로그인 시도가 너무 많아 계정이 잠겼습니다. ${minutesLeft}분 후 다시 시도해주세요.` },
    });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: shouldLock
        ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS) }
        : { failedLoginAttempts: attempts },
    });
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } });
  }

  if (!user.auditorTotpEnabledAt) {
    // 최초 로그인(또는 감사인이 새로 바뀐 뒤 첫 로그인) — OTP 인증앱 등록이 필요하다. 아직 비밀키를
    // DB에 저장하지 않고, 서명된 임시 토큰(5분 유효) 안에만 담아 클라이언트로 보낸다 — 등록 화면만
    // 보고 중간에 끝내버려도 미사용 비밀키가 DB에 남지 않도록, enroll-confirm에서 코드 확인에
    // 성공해야만 비로소 저장한다.
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.employeeNo, 'DSTI-TSB 감사인', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    const enrollToken = signAuditPendingToken({ userId: user.id, purpose: 'AUDIT_ENROLL', secret });
    return res.json({ success: true, data: { step: 'ENROLL' as const, enrollToken, qrDataUrl, secret } });
  }

  const verifyToken = signAuditPendingToken({ userId: user.id, purpose: 'AUDIT_VERIFY' });
  return res.json({ success: true, data: { step: 'VERIFY' as const, verifyToken } });
});

async function issueAuditAccessToken(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const token = signAccessToken({ userId: user.id, roles: ['AUDITOR'], departmentId: user.departmentId, tokenVersion: user.tokenVersion });
  return {
    accessToken: token,
    user: { id: user.id, name: user.name, email: user.email, employeeNo: user.employeeNo, roles: ['AUDITOR'] },
  };
}

const auditOtpCodeSchema = z.string().regex(/^\d{6}$/, '6자리 숫자를 입력하세요.');

authRouter.post('/audit-login/enroll-confirm', async (req, res) => {
  const parsed = z.object({ enrollToken: z.string().min(1), code: auditOtpCodeSchema }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' } });
  }
  const { enrollToken, code } = parsed.data;
  const payload = verifyAuditPendingToken(enrollToken);
  if (!payload || payload.purpose !== 'AUDIT_ENROLL' || !payload.secret) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '등록 세션이 만료되었습니다. 처음부터 다시 시도해주세요.' } });
  }
  const { user, isAuditor } = await findAuditorAccount(payload.userId);
  // 등록 화면을 열어둔 사이(최대 5분)에 관리자가 감사인 권한을 회수했을 수도 있으니 한 번 더 확인한다.
  if (!user || user.id !== payload.userId || !isAuditor) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '권한이 없습니다.' } });
  }
  if (!authenticator.check(code, payload.secret)) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_OTP', message: '인증번호가 올바르지 않습니다. 인증앱의 최신 코드를 다시 확인해주세요.' } });
  }
  await prisma.user.update({ where: { id: user.id }, data: { auditorTotpSecret: payload.secret, auditorTotpEnabledAt: new Date(), lastLoginAt: new Date() } });
  const issued = await issueAuditAccessToken(user.id);
  return res.json({ success: true, data: issued });
});

authRouter.post('/audit-login/verify', async (req, res) => {
  const parsed = z.object({ verifyToken: z.string().min(1), code: auditOtpCodeSchema }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' } });
  }
  const { verifyToken, code } = parsed.data;
  const payload = verifyAuditPendingToken(verifyToken);
  if (!payload || payload.purpose !== 'AUDIT_VERIFY') {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '인증 세션이 만료되었습니다. 처음부터 다시 시도해주세요.' } });
  }
  const { user, isAuditor } = await findAuditorAccount(payload.userId);
  if (!user || user.id !== payload.userId || !isAuditor || !user.auditorTotpSecret) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '권한이 없습니다.' } });
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutesLeft = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
    return res.status(423).json({
      success: false,
      error: { code: 'ACCOUNT_LOCKED', message: `시도가 너무 많아 계정이 잠겼습니다. ${minutesLeft}분 후 다시 시도해주세요.` },
    });
  }
  if (!authenticator.check(code, user.auditorTotpSecret)) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: shouldLock
        ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS) }
        : { failedLoginAttempts: attempts },
    });
    return res.status(401).json({ success: false, error: { code: 'INVALID_OTP', message: '인증번호가 올바르지 않습니다.' } });
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const issued = await issueAuditAccessToken(user.id);
  return res.json({ success: true, data: issued });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const authUser = req.authUser!;
  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    include: { department: true, assignedClient: true, userRoles: { include: { role: true } } },
  });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
  }
  return res.json({
    success: true,
    data: {
      id: user.id,
      employeeNo: user.employeeNo,
      name: user.name,
      email: user.email,
      department: user.department.name,
      workType: user.workType,
      assignedClient: user.assignedClient?.name ?? null,
      // 2026-09-20: DB에 있는 역할을 그대로 다 보여주지 않고, 지금 쓰고 있는 이 토큰이 실제로
      // 갖고 있는 역할(authUser.roles, JWT에 실제로 서명되어 있는 값)과 교집합만 보여준다.
      // AUDITOR가 대표적인 이유 — 감사인으로 지정된 사람이 평소처럼 일반 로그인을 하면 토큰에는
      // AUDITOR가 안 실리는데(rolesExcludingAuditor), 여기서 DB 역할을 그대로 보여주면 "나는
      // 감사인 권한이 있다"고 착각하게 만든다(실제로는 이 세션으로 감사 화면 API를 호출하면
      // 403이 남). 부수 효과로, 역할이 회수된 뒤 재로그인 전까지 이전 역할이 여기 남아 보이던
      // 기존의 사소한 불일치도 같이 없어진다.
      roles: user.userRoles.map((ur: { role: { code: string } }) => ur.role.code).filter((code: string) => authUser.roles.includes(code)),
      mustChangePassword: user.mustChangePassword,
      locationConsentGiven: user.locationConsentAt != null,
      privacyConsentGiven: user.privacyConsentAt != null,
    },
  });
});

/**
 * 고객사 방문 위치대조 기능에 대한 최초 동의 기록. 이미 동의했으면 그대로 둔다(재동의 불필요).
 * 위치정보보호법상 목적을 명시하고 명시적 동의를 받아야 하므로, 브라우저 권한창과 별개로
 * 이 동의 기록을 서버에 남겨 법적 근거로 삼는다.
 * 2026-08-30부터 개인정보 동의와 함께 앱 사용의 필수 전제조건 — frontend의 MandatoryConsentGate가
 * 두 동의를 모두 받기 전까지 앱 화면을 가린다(우회 불가, "나중에" 건너뛰기 없음).
 */
authRouter.post('/location-consent', requireAuth, async (req, res) => {
  const userId = req.authUser!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
  }
  if (!user.locationConsentAt) {
    await prisma.user.update({ where: { id: userId }, data: { locationConsentAt: new Date() } });
  }
  return res.json({ success: true, data: { consented: true } });
});

/**
 * 개인정보 수집·이용에 대한 최초 동의 기록. 위치정보 동의와 마찬가지로 앱 사용의 필수 전제조건이다
 * (2026-08-30, 엔지니어/과장급 전사 확산에 맞춰 도입). 이미 동의했으면 그대로 둔다(재동의 불필요).
 */
authRouter.post('/privacy-consent', requireAuth, async (req, res) => {
  const userId = req.authUser!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
  }
  if (!user.privacyConsentAt) {
    await prisma.user.update({ where: { id: userId }, data: { privacyConsentAt: new Date() } });
  }
  return res.json({ success: true, data: { consented: true } });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, '비밀번호는 10자 이상이어야 합니다.'),
});

/** 본인 비밀번호 변경. 최초 로그인 강제 변경, 그리고 이후 자율 변경 둘 다 이 API를 쓴다. */
authRouter.post('/change-password', requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message || '입력값을 확인하세요.' },
    });
  }
  const { currentPassword, newPassword } = parsed.data;
  const userId = req.authUser!.userId;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '현재 비밀번호가 올바르지 않습니다.' } });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  // 2026-08-30 보안점검: 비밀번호를 바꾸면 tokenVersion을 올려서 이전에 발급된 모든 토큰(다른 기기 포함)을
  // 즉시 무효화한다. 지금 요청에 쓰인 토큰도 예외가 아니므로, 새 tokenVersion으로 토큰을 다시 발급해서
  // 돌려준다 — 프론트는 이 토큰으로 갈아끼워야 로그아웃되지 않고 계속 쓸 수 있다(change-password.tsx 참고).
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash, mustChangePassword: false, tokenVersion: { increment: 1 } },
  });
  const newToken = signAccessToken({
    userId: updated.id,
    roles: req.authUser!.roles,
    departmentId: updated.departmentId,
    tokenVersion: updated.tokenVersion,
  });

  return res.json({ success: true, data: { changed: true, accessToken: newToken } });
});
