import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'));

/**
 * 상황판/출퇴근 현황 표시 대상 관리(2026-09-04 추가) — 다우오피스 전체 조직도가 아니라 특정
 * 부서·인원만 시범적으로 표시하길 원해서, 부서별로 묶어서 한눈에 보고 부서 단위/개별로 켜고
 * 끌 수 있게 재직중인 전 직원 목록을 반환한다(HR_ADMIN/SYSTEM_ADMIN 전용 — TEAM_LEAD는 접근 불가).
 * 로그인 이력(lastLoginAt)도 함께 내려줘서 같은 화면에서 "앱을 안 쓰는 사람"도 바로 보이게 한다.
 */
usersRouter.get('/board-scope', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
    select: {
      id: true,
      name: true,
      employeeNo: true,
      includedInBoard: true,
      lastLoginAt: true,
      department: { select: { id: true, name: true } },
    },
    orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
  });
  return res.json({ success: true, data: users });
});

const boardScopeUpdateSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1),
  included: z.boolean(),
});

usersRouter.post('/board-scope', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  const parsed = boardScopeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const { userIds, included } = parsed.data;
  await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { includedInBoard: included } });
  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'POLICY_CHANGE',
    targetType: 'user.includedInBoard',
    afterValue: { userIds, included },
  });
  return res.json({ success: true, data: { updated: userIds.length, included } });
});

/**
 * 2026-09-20: "감사인" 권한 관리(대표이사 요청) — 재택 위치 열람(AUDITOR)을 누구에게 줄지
 * SYSTEM_ADMIN이 직접 개별 계정 단위로 지정한다. HR_ADMIN/TEAM_LEAD는 이 두 엔드포인트에
 * 접근할 수 없다(위 usersRouter.use의 requireRole은 통과하지만, 아래에서 SYSTEM_ADMIN을
 * 한 번 더 요구한다) — "특정 감사인만" 볼 수 있어야 한다는 원칙을 권한 부여 자체에도 적용해,
 * HR_ADMIN이 스스로에게 감사인 권한을 주는 것도 막는다.
 */
usersRouter.get('/auditors', requireRole('SYSTEM_ADMIN'), async (_req, res) => {
  const [users, auditorRole] = await Promise.all([
    prisma.user.findMany({
      where: { employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
      select: {
        id: true,
        name: true,
        employeeNo: true,
        department: { select: { id: true, name: true } },
        userRoles: { select: { role: { select: { code: true } } } },
      },
      orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
    }),
    prisma.role.findUnique({ where: { code: 'AUDITOR' } }),
  ]);
  interface AuditorCandidateUser {
    id: string;
    name: string;
    employeeNo: string;
    department: { id: string; name: string };
    userRoles: { role: { code: string } }[];
  }
  const data = users.map((u: AuditorCandidateUser) => ({
    id: u.id,
    name: u.name,
    employeeNo: u.employeeNo,
    department: u.department,
    isAuditor: u.userRoles.some((ur: { role: { code: string } }) => ur.role.code === 'AUDITOR'),
  }));
  return res.json({ success: true, data: { users: data, auditorRoleReady: Boolean(auditorRole) } });
});

const auditorGrantSchema = z.object({
  userId: z.string().uuid(),
  granted: z.boolean(),
});

usersRouter.post('/auditors', requireRole('SYSTEM_ADMIN'), async (req, res) => {
  const parsed = auditorGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const { userId, granted } = parsed.data;
  const auditorRole = await prisma.role.findUnique({ where: { code: 'AUDITOR' } });
  if (!auditorRole) {
    return res.status(500).json({ success: false, error: { code: 'ROLE_NOT_READY', message: 'AUDITOR 역할이 아직 준비되지 않았습니다. 서버를 재시작한 뒤 다시 시도해주세요.' } });
  }
  if (granted) {
    // 2026-09-20: UserRole의 복합 유니크(userId+roleId+scopeDepartmentId)는 scopeDepartmentId가
    // nullable이라 Prisma upsert의 where 타입과 맞추기가 번거롭다 — 직접 존재 여부를 확인하고
    // 없을 때만 생성하는 방식으로 단순하게 처리한다(레이스 컨디션은 SYSTEM_ADMIN 소수만 쓰는
    // 저빈도 관리 화면이라 실질적 위험이 없다).
    const existingGrant = await prisma.userRole.findFirst({
      where: { userId, roleId: auditorRole.id, scopeDepartmentId: null },
    });
    if (!existingGrant) {
      await prisma.userRole.create({ data: { userId, roleId: auditorRole.id } });
    }
  } else {
    await prisma.userRole.deleteMany({ where: { userId, roleId: auditorRole.id } });
  }
  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'POLICY_CHANGE',
    targetType: 'user.auditorRole',
    targetId: userId,
    afterValue: { granted },
  });
  // 2026-09-20: 권한은 로그인 시 JWT에 그대로 실려서 발급되므로(7일 유효), 이미 로그인해 있던
  // 계정은 재로그인 전까지는 새 권한이 반영되지 않는다 — 프론트에서 이 사실을 안내한다.
  return res.json({ success: true, data: { userId, granted, note: '대상자가 이미 로그인해 있다면, 다시 로그인해야 권한이 적용됩니다.' } });
});

/**
 * 직원 상세 조회. 역할에 따라 필드를 마스킹한다.
 * - TEAM_LEAD: 자기 부서 소속만 조회 가능, 연락처 등 일부 필드 마스킹
 * - HR_ADMIN/SYSTEM_ADMIN: 전체 조회 가능(단, 위치 상세는 별도 권한 필요 — MVP는 좌표 자체를 저장하지 않음)
 * 모든 조회는 감사로그(VIEW)로 기록한다.
 */
usersRouter.get('/:id', async (req, res) => {
  const authUser = req.authUser!;
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { department: true, assignedClient: true, userRoles: { include: { role: true } } },
  });
  if (!target) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
  }

  const isTeamLeadOnly = authUser.roles.includes('TEAM_LEAD') && !authUser.roles.some((r) => ['HR_ADMIN', 'SYSTEM_ADMIN'].includes(r));
  if (isTeamLeadOnly && target.departmentId !== authUser.departmentId) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '소속 부서 인원만 조회할 수 있습니다.' } });
  }

  const base: Record<string, unknown> = {
    id: target.id,
    employeeNo: target.employeeNo,
    name: target.name,
    department: target.department.name,
    workType: target.workType,
    employmentStatus: target.employmentStatus,
    assignedClient: target.assignedClient?.name ?? null,
    roles: target.userRoles.map((ur) => ur.role.code),
  };
  // TEAM_LEAD는 이메일(연락처에 준하는 개인정보) 마스킹. 다우오피스 동기화 계정은 이메일이 없을 수 있음.
  base.email = isTeamLeadOnly ? maskEmail(target.email) : target.email;

  await recordAuditLog({
    actorUserId: authUser.userId,
    actionType: 'VIEW',
    targetType: 'user',
    targetId: target.id,
  });

  return res.json({ success: true, data: base });
});

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [localPart, domain] = email.split('@');
  if (!domain) return '***';
  const visible = localPart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, localPart.length - 2))}@${domain}`;
}
