import { Router } from 'express';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { REMOTE_AUDIT_COORD_RETENTION_DAYS } from '../../common/location';

/**
 * 2026-09-20: "감사인 전용 재택 위치 열람"(대표이사 승인) — 재택(REMOTE) 근무 등록 시 캡처된
 * 원본 GPS 좌표(StatusChangeLog.remoteAuditLatitude/Longitude)를 조회하는 유일한 API.
 *
 * HR_ADMIN/SYSTEM_ADMIN을 포함한 일반 관리자는 이 라우터에 접근할 수 없다 — AUDITOR 권한을
 * 별도로 부여받은 계정만 통과한다(권한 부여는 /users/auditors, SYSTEM_ADMIN 전용).
 * 조회할 때마다 "누가 언제 열람했는지" 감사로그(LOCATION_DETAIL_VIEW)를 남긴다 — 감사인 자신에
 * 대한 감사이기도 하다.
 */
export const auditLocationRouter = Router();
auditLocationRouter.use(requireAuth, requireRole('AUDITOR'));

auditLocationRouter.get('/remote', async (req, res) => {
  const authUser = req.authUser!;
  const days = Math.min(Math.max(Number(req.query.days) || REMOTE_AUDIT_COORD_RETENTION_DAYS, 1), REMOTE_AUDIT_COORD_RETENTION_DAYS);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const logs = await prisma.statusChangeLog.findMany({
    where: {
      status: 'REMOTE',
      changedAt: { gte: since },
      OR: [{ remoteAuditLatitude: { not: null } }, { remoteAuditLongitude: { not: null } }],
    },
    select: {
      id: true,
      changedAt: true,
      remoteAuditLatitude: true,
      remoteAuditLongitude: true,
      note: true,
      user: {
        select: { id: true, name: true, employeeNo: true, department: { select: { name: true } } },
      },
    },
    orderBy: { changedAt: 'desc' },
    take: 500,
  });

  await recordAuditLog({
    actorUserId: authUser.userId,
    actionType: 'LOCATION_DETAIL_VIEW',
    targetType: 'status_change_log.remote_audit_location',
    afterValue: { resultCount: logs.length, days },
  });

  interface RemoteAuditLogRow {
    id: string;
    changedAt: Date;
    remoteAuditLatitude: number | null;
    remoteAuditLongitude: number | null;
    note: string | null;
    user: { id: string; name: string; employeeNo: string; department: { name: string } };
  }
  return res.json({
    success: true,
    data: {
      retentionDays: REMOTE_AUDIT_COORD_RETENTION_DAYS,
      entries: logs.map((l: RemoteAuditLogRow) => ({
        id: l.id,
        changedAt: l.changedAt,
        userName: l.user.name,
        employeeNo: l.user.employeeNo,
        department: l.user.department.name,
        latitude: l.remoteAuditLatitude,
        longitude: l.remoteAuditLongitude,
        note: l.note,
      })),
    },
  });
});
