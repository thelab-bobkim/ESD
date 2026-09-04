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
