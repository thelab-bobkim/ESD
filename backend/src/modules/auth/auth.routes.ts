import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, signAccessToken } from '../../common/guards/auth';

export const authRouter = Router();

const loginSchema = z.object({
  // 이메일이 있는 계정은 이메일로, 다우오피스 동기화 계정(이메일 없음)은 사번/다우오피스 로그인ID로 로그인한다.
  identifier: z.string().min(1),
  password: z.string().min(1),
});

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
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } });
  }

  const roles = user.userRoles.map((ur) => ur.role.code);
  const token = signAccessToken({ userId: user.id, roles, departmentId: user.departmentId });

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
    },
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.'),
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
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash, mustChangePassword: false },
  });

  return res.json({ success: true, data: { changed: true } });
});
