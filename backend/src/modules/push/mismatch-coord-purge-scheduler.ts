import { prisma } from '../../common/prisma';
import { MISMATCH_COORD_RETENTION_DAYS, REMOTE_AUDIT_COORD_RETENTION_DAYS, clampRemoteAuditRetentionDays } from '../../common/location';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

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
    // 2026-09-30(M-16): 정책값으로 더 짧게 줄일 수 있다(늘리는 건 불가 — clampRemoteAuditRetentionDays).
    const remoteRetentionDays = clampRemoteAuditRetentionDays(
      await getPolicyNumber('REMOTE_AUDIT_COORD_RETENTION_DAYS', REMOTE_AUDIT_COORD_RETENTION_DAYS)
    );
    const remoteAuditCutoff = new Date(Date.now() - remoteRetentionDays * 24 * 60 * 60 * 1000);
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
        `[MismatchCoordPurge] 보관기간 경과 좌표 삭제: statusChangeLog(불일치)=${statusLogResult.count}건, residentCheckin=${residentCheckinResult.count}건, 재택위치감사(${remoteRetentionDays}일)=${remoteAuditResult.count}건`
      );
    }
  };

  setInterval(async () => {
    try {
      // 2026-09-30 수정: getHours()는 서버(컨테이너)의 로컬 시각을 쓰는데, 이 앱의 배포환경은
      // TZ를 KST로 맞춰두지 않아(Dockerfile/compose 어디에도 TZ 설정 없음, node:20-slim 기본은
      // UTC) getHours()===0은 실제로는 UTC 00시, 즉 KST 09시였다 — reminder-scheduler.ts의
      // kstHourOf()와 동일하게 KST로 변환해서 비교해야 주석에 적힌 "자정(00:00~00:59, KST)"이
      // 실제 동작과 맞는다(하루 1회만 도는 특성상 지워지는 시점만 늦었을 뿐 삭제 자체가 누락/중복
      // 되진 않았지만, 위치정보보호법 "즉시파기" 취지상 의도한 시각에 지워야 한다).
      const kstHour = (new Date().getUTCHours() + 9) % 24;
      if (kstHour !== 0) return;
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
