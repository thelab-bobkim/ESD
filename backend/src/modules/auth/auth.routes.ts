import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, signAccessToken } from '../../common/guards/auth';

export const authRouter = Router();

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

  const roles = user.userRoles.map((ur) => ur.role.code);
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

  const roles = user.userRoles.map((ur: { role: { code: string } }) => ur.role.code);
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

  const roles = user.userRoles.map((ur) => ur.role.code);
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
      roles: user.userRoles.map((ur) => ur.role.code),
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
