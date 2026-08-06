import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { DauofficeClient } from './dauoffice-client';

export interface AttendanceSyncResult {
  syncedCount: number;
  errors: string[];
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // month: 1~12
}

/**
 * 지정한 년/월의 다우오피스 출근기록을 ESD의 attendance_records.clock_in_at 으로 동기화한다.
 * (AMS의 sync_attendance_from_dauoffice 이식)
 *
 * - 다우오피스는 출근시각(startWorkTime)만 제공하므로 clockInAt만 채운다. 퇴근/휴게/상태변경은
 *   ESD 자체 기능으로 계속 관리한다.
 * - 관리자가 수동으로 정정한 기록(dataSource=MANUAL)은 자동 동기화가 덮어쓰지 않는다.
 * - 회사가 한국(서울) 소재이므로 시각은 KST(+09:00) 기준으로 해석한다.
 */
export async function syncAttendanceFromDauoffice(
  year: number,
  month: number,
  actorUserId: string | null
): Promise<AttendanceSyncResult> {
  const client = new DauofficeClient();
  const result: AttendanceSyncResult = { syncedCount: 0, errors: [] };

  if (!client.isConfigured()) {
    result.errors.push('DAUOFFICE_CLIENT_ID/SECRET이 설정되지 않았습니다.');
    return result;
  }

  const lastDay = lastDayOfMonth(year, month);
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  let page = 0;
  const pageSize = 50;

  // 이번 배치에서 사용할 유저 캐시(다우오피스 loginId -> userId)
  const userCache = new Map<string, string | null>();

  while (true) {
    const pageResult = await client.getAttendanceRecords(startDate, endDate, page, pageSize);
    if (pageResult.elements.length === 0) break;

    for (const att of pageResult.elements) {
      const loginId = att.loginId;
      if (!loginId) continue;
      if (!att.accrualDate || !att.startWorkTime) continue;

      let userId: string | null = userCache.get(loginId) ?? null;
      if (!userCache.has(loginId)) {
        const user = await prisma.user.findFirst({
          where: { dauofficeUserId: loginId, employmentStatus: 'ACTIVE' },
        });
        userId = user?.id ?? null;
        userCache.set(loginId, userId);
      }
      if (!userId) continue;

      // 주의: workDate는 DATE 컬럼이라 "그 날짜"만 의미가 있어야 한다.
      // KST(+09:00)로 변환한 자정을 그대로 Date로 넣으면 UTC 기준으로는 전날로 저장되는 버그가 있었다.
      // attendance.routes.ts의 todayDateOnly()와 동일하게 UTC 자정 기준으로 날짜만 계산한다.
      const [y, m, d] = att.accrualDate.split('-').map(Number);
      const workDate = new Date(Date.UTC(y, m - 1, d));
      const clockInAt = new Date(`${att.accrualDate}T${att.startWorkTime.split(' ')[1] ?? att.startWorkTime}+09:00`);
      if (Number.isNaN(clockInAt.getTime())) continue;

      try {
        const existing = await prisma.attendanceRecord.findUnique({
          where: { userId_workDate: { userId, workDate } },
        });
        if (!existing) {
          await prisma.attendanceRecord.create({
            data: { userId, workDate, clockInAt, dataSource: 'DAUOFFICE' },
          });
          result.syncedCount += 1;
        } else if (existing.dataSource === 'DAUOFFICE') {
          await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt } });
          result.syncedCount += 1;
        }
        // dataSource가 MANUAL인 기존 기록은 보호하고 건너뜀
      } catch (err) {
        result.errors.push(`${loginId} ${att.accrualDate} 처리 중 오류: ${(err as Error).message}`);
      }
    }

    page += 1;
    if (page >= pageResult.totalPages) break;
  }

  await recordAuditLog({
    actorUserId,
    actionType: 'STATUS_CHANGE',
    targetType: 'dauoffice_sync_attendance',
    afterValue: { year, month, ...result },
  });

  return result;
}
