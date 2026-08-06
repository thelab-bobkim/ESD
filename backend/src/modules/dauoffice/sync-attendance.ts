import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { getPolicyBoolean } from '../../common/policy-engine/policy-engine';
import { DauofficeClient } from './dauoffice-client';

export interface AttendanceSyncResult {
  syncedCount: number;
  statusInferredCount: number;
  errors: string[];
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // month: 1~12
}

interface CachedUser {
  id: string;
  workType: string;
  assignedClientId: string | null;
}

/**
 * 다우오피스 출근기록만으로는 "본사근무"인지 "고객사상주"인지 완벽히 알 수 없으므로
 * 근무유형(workType)을 기준으로 가장 그럴듯한 상태를 추정한다(잠정값).
 * 직원이 ESD에서 직접 정확한 상태로 바꾸면 그 값이 항상 우선한다.
 */
function inferStatus(user: CachedUser): 'HQ_WORKING' | 'RESIDENT_ONSITE' {
  if (user.workType === 'RESIDENT' && user.assignedClientId) return 'RESIDENT_ONSITE';
  return 'HQ_WORKING';
}

/**
 * 지정한 년/월의 다우오피스 출근기록을 ESD의 attendance_records.clock_in_at 으로 동기화한다.
 * (AMS의 sync_attendance_from_dauoffice 이식)
 *
 * - 다우오피스는 출근시각(startWorkTime)만 제공하므로 clockInAt만 채운다. 퇴근/휴게/상태변경은
 *   ESD 자체 기능으로 계속 관리한다.
 * - 관리자가 수동으로 정정한 기록(dataSource=MANUAL)은 자동 동기화가 덮어쓰지 않는다.
 * - 회사가 한국(서울) 소재이므로 시각은 KST(+09:00) 기준으로 해석한다.
 * - 정책값 DAUOFFICE_INFER_STATUS_FROM_ATTENDANCE(기본 true)가 켜져 있으면, "오늘" 다우오피스
 *   출근기록이 있는데 그 직원이 오늘 ESD에서 상태를 바꾼 적이 없으면 잠정 상태(본사근무/고객사상주)를
 *   자동으로 채워 "상태 미확인" 알림을 줄인다. 직원이 오늘 실제로 상태를 바꾼 적이 있으면 절대 덮어쓰지 않는다.
 */
export async function syncAttendanceFromDauoffice(
  year: number,
  month: number,
  actorUserId: string | null
): Promise<AttendanceSyncResult> {
  const client = new DauofficeClient();
  const result: AttendanceSyncResult = { syncedCount: 0, statusInferredCount: 0, errors: [] };

  if (!client.isConfigured()) {
    result.errors.push('DAUOFFICE_CLIENT_ID/SECRET이 설정되지 않았습니다.');
    return result;
  }

  const inferStatusEnabled = await getPolicyBoolean('DAUOFFICE_INFER_STATUS_FROM_ATTENDANCE', true);

  const lastDay = lastDayOfMonth(year, month);
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // "오늘" 판정 기준(UTC 자정) — attendance.routes.ts의 todayDateOnly()와 동일한 기준
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  let page = 0;
  const pageSize = 50;

  // 이번 배치에서 사용할 유저 캐시(다우오피스 loginId -> 유저 정보)
  const userCache = new Map<string, CachedUser | null>();

  while (true) {
    const pageResult = await client.getAttendanceRecords(startDate, endDate, page, pageSize);
    if (pageResult.elements.length === 0) break;

    for (const att of pageResult.elements) {
      const loginId = att.loginId;
      if (!loginId) continue;
      if (!att.accrualDate || !att.startWorkTime) continue;

      let user: CachedUser | null = userCache.get(loginId) ?? null;
      if (!userCache.has(loginId)) {
        const found = await prisma.user.findFirst({
          where: { dauofficeUserId: loginId, employmentStatus: 'ACTIVE' },
          select: { id: true, workType: true, assignedClientId: true },
        });
        user = found ?? null;
        userCache.set(loginId, user);
      }
      if (!user) continue;
      const userId = user.id;

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

        // 오늘자 기록이면, 상태 미확인을 줄이기 위해 잠정 상태를 채워본다.
        if (inferStatusEnabled && workDate.getTime() === todayUTC.getTime()) {
          const latestStatus = await prisma.statusChangeLog.findFirst({
            where: { userId },
            orderBy: { changedAt: 'desc' },
          });
          const alreadySetToday = latestStatus && latestStatus.changedAt >= todayUTC;
          if (!alreadySetToday) {
            await prisma.statusChangeLog.create({
              data: {
                userId,
                status: inferStatus(user),
                source: 'SYSTEM',
                note: '다우오피스 출근기록 기반 자동 추정(직원이 실제 상태로 변경 전까지의 잠정값)',
              },
            });
            result.statusInferredCount += 1;
          }
        }
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
