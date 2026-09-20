import { prisma } from '../../common/prisma';
import { MISMATCH_COORD_RETENTION_DAYS, REMOTE_AUDIT_COORD_RETENTION_DAYS } from '../../common/location';

/**
 * "불일치 건만 좌표 저장" 정책(2026-09-18, 사용자 승인)의 짝 — 보관기간 자동삭제 스케줄러.
 *
 * StatusChangeLog/ResidentCheckin에 예외적으로 남겨둔 원본 좌표(mismatchLatitude/mismatchLongitude)를
 * MISMATCH_COORD_RETENTION_DAYS(기본 30일)가 지나면 null로 지운다. 위치정보보호법의 "목적 달성 시
 * 즉시파기" 원칙에 대응하기 위함 — 관리자가 근무태만 의심 건을 확인할 시간은 충분히 주되, 원본 GPS
 * 좌표를 무기한 쌓아두지는 않는다.
 *
 * 다른 컬럼(locationMatch/locationDistanceMeters 등 대조 "결과"만 남은 값)은 애초에 개인 위치를
 * 역추적할 수 없으므로 삭제 대상이 아니다 — 오직 원본 좌표 2개 컬럼만 대상.
 */
export function startMismatchCoordPurgeScheduler() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간마다 확인 (자정 근처 하루 1회만 실제 삭제 수행)

  const runPurge = async () => {
    const cutoff = new Date(Date.now() - MISMATCH_COORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    // 2026-09-20: "감사인 전용 재택 위치" 좌표(remoteAuditLatitude/Longitude)도 같은 원칙(위치정보
    // 보호법상 목적 달성 시 즉시파기)으로 별도 보관기간이 지나면 자동삭제한다 — 지금은 두 보관기간
    // 값이 같지만(REMOTE_AUDIT_COORD_RETENTION_DAYS), 나중에 감사 목적상 서로 달라질 수 있어
    // cutoff 계산을 분리해뒀다.
    const remoteAuditCutoff = new Date(Date.now() - REMOTE_AUDIT_COORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const [statusLogResult, residentCheckinResult, remoteAuditResult] = await Promise.all([
      prisma.statusChangeLog.updateMany({
        where: {
          changedAt: { lt: cutoff },
          OR: [{ mismatchLatitude: { not: null } }, { mismatchLongitude: { not: null } }],
        },
        data: { mismatchLatitude: null, mismatchLongitude: null },
      }),
      prisma.residentCheckin.updateMany({
        where: {
          checkinAt: { lt: cutoff },
          OR: [{ mismatchLatitude: { not: null } }, { mismatchLongitude: { not: null } }],
        },
        data: { mismatchLatitude: null, mismatchLongitude: null },
      }),
      prisma.statusChangeLog.updateMany({
        where: {
          changedAt: { lt: remoteAuditCutoff },
          OR: [{ remoteAuditLatitude: { not: null } }, { remoteAuditLongitude: { not: null } }],
        },
        data: { remoteAuditLatitude: null, remoteAuditLongitude: null },
      }),
    ]);
    if (statusLogResult.count > 0 || residentCheckinResult.count > 0 || remoteAuditResult.count > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[MismatchCoordPurge] 보관기간 경과 좌표 삭제: statusChangeLog(불일치)=${statusLogResult.count}건, residentCheckin=${residentCheckinResult.count}건, 재택위치감사(${REMOTE_AUDIT_COORD_RETENTION_DAYS}일)=${remoteAuditResult.count}건`
      );
    }
  };

  setInterval(async () => {
    try {
      // 자정(00:00~00:59)에만 실제 삭제를 수행한다 — 매시간 불필요하게 전체 스캔하지 않기 위함.
      if (new Date().getHours() !== 0) return;
      await runPurge();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[MismatchCoordPurge] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);

  // 서버 시작 시에도 한 번 즉시 실행해서, 재배포 텀이 길었던 경우에도 보관기간 초과분이
  // 자정까지 방치되지 않게 한다.
  runPurge().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[MismatchCoordPurge] 시작 시 실행 오류:', err);
  });
}
