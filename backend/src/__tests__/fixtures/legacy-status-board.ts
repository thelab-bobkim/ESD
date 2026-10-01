/* eslint-disable */
// 테스트 전용: M-5 수정 직전(a10b7c8 + 0001~0005)의 buildStatusBoard 원문을 그대로 보존한 것.
// 새 일괄조회 구현(dashboard.routes.ts buildStatusBoard)과 결과가 완전히 같은지 비교하는 기준으로만 쓴다.
import { prisma } from '../../common/prisma';
import { realDayWindow, PROVISIONAL_HQ_NOTE } from '../../common/attendance-helpers';

const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK']);
const LOCATION_CHECK_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK']);
function dateOnlyUTC(d?: Date): Date {
  if (d) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const now = new Date();
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  return new Date(Date.UTC(kstShifted.getUTCFullYear(), kstShifted.getUTCMonth(), kstShifted.getUTCDate()));
}

export async function buildStatusBoardLegacy(userIds?: string[], forDate: Date = dateOnlyUTC(), includeMismatchCoords = false) {
  const workDateLabel = forDate;
  const { start: dayStart, end: dayEnd } = realDayWindow(workDateLabel);

  const users = await prisma.user.findMany({
    where: {
      ...(userIds ? { id: { in: userIds } } : {}),
      // 파일럿 초기 세팅용 SAMPLE_ 테스트 계정은 실제 상황판에서 제외한다.
      name: { not: { startsWith: 'SAMPLE_' } },
      // 2026-09-04: 다우오피스 전체 조직도가 아니라 admin/board-scope에서 명시적으로 켠 부서/인원만
      // 상황판에 표시한다(회사 요청으로 시범 범위를 좁힘) — users.routes.ts board-scope 참고.
      includedInBoard: true,
    },
    include: { department: true, assignedClient: true },
  });

  const board = await Promise.all(
    users.map(async (u) => {
      const statusOnDay = await prisma.statusChangeLog.findFirst({
        where: { userId: u.id, changedAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { changedAt: 'desc' },
      });
      const checkinOnDay = await prisma.residentCheckin.findFirst({
        where: { userId: u.id, checkinAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { checkinAt: 'desc' },
      });
      // 퇴근했으면 상황판에서 "마지막 상태" 대신 "퇴근완료"로 보여줄 수 있게 별도로 알려준다.
      // 단, 야간작업자는 퇴근 후에도 계속 상태를 등록할 수 있으므로, 퇴근시각 이후 새로 등록된
      // 상태가 있으면(=야간작업 등) 그 상태를 그대로 보여주고 "퇴근완료"로 덮어쓰지 않는다.
      const attendanceOnDay = await prisma.attendanceRecord.findUnique({
        where: { userId_workDate: { userId: u.id, workDate: workDateLabel } },
      });
      const clockedOut = Boolean(attendanceOnDay?.clockOutAt)
        && (!statusOnDay || statusOnDay.changedAt <= attendanceOnDay!.clockOutAt!);
      // note가 비어있는데 상태가 공수 대상(EFFORT_STATUSES)이면, 세부폼 제출 전이라도 이미
      // 남아있을 수 있는 effort_logs의 고객사명을 대신 조회해서 보여준다(위 EFFORT_STATUSES 주석 참고).
      const needsEffortFallback = !statusOnDay?.note && statusOnDay?.status && EFFORT_STATUSES.has(statusOnDay.status);
      const fallbackEffort = needsEffortFallback
        ? await prisma.effortLog.findFirst({ where: { userId: u.id, workDate: workDateLabel }, orderBy: { startTime: 'desc' } })
        : null;
      // 2026-09-09: 상황판 위치 배지가 "그날 마지막 상태변경 로그" 1건의 locationMatch만 보고
      // 판단하던 문제를 개선 — 위치대조 대상 상태(본사근무/고객사미팅/고객사작업)를 하루에 여러 번
      // 등록하는 직원은, 예를 들어 오전 본사근무 등록 때 위치가 정상 확인됐어도 오후에 좌표 등록이
      // 안 된 고객사로 재등록하면 마지막 로그만 보고 하루 종일 "위치 미확인"으로 표시됐다(관리자
      // 문의 "위치 미확인 다수" 원인). 그날 같은 종류의 상태 등록 중 단 한 번이라도 위치 확인에
      // 성공(locationMatch=true)한 이력이 있으면, 그 이력을 기준으로 확인됨 처리한다.
      const statusIsLocationChecked = Boolean(statusOnDay?.status && LOCATION_CHECK_STATUSES.has(statusOnDay.status));
      const bestLocationLogToday = statusIsLocationChecked && statusOnDay?.locationMatch !== true
        ? await prisma.statusChangeLog.findFirst({
            where: {
              userId: u.id,
              changedAt: { gte: dayStart, lt: dayEnd },
              // 2026-09-19: 위 LOCATION_CHECK_STATUSES를 그대로 spread하면 string[]로 넓혀져 Prisma의
              // AttendanceStatus enum 타입과 안 맞을 수 있어(로컬 스텁은 못 잡고 실제 서버 빌드에서만
              // 걸리는 유형 — attendance.routes.ts에서도 겪음) 안전하게 리터럴로 나열한다. 이 네 값은
              // 위 LOCATION_CHECK_STATUSES 정의와 반드시 같이 유지되어야 한다.
              status: { in: ['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK'] },
              locationMatch: true,
            },
            orderBy: { changedAt: 'desc' },
          })
        : null;
      const effectiveLocationMatch = bestLocationLogToday
        ? true
        : (statusOnDay?.locationMatch ?? checkinOnDay?.locationMatch ?? null);
      const effectiveLocationDistanceMeters = bestLocationLogToday
        ? bestLocationLogToday.locationDistanceMeters
        : (statusOnDay?.locationDistanceMeters ?? checkinOnDay?.locationDistanceMeters ?? null);
      const effectiveLocationCaptureStatus = bestLocationLogToday
        ? (bestLocationLogToday.locationCaptureStatus ?? 'OK')
        : (statusOnDay?.locationCaptureStatus ?? null);
      // 2026-09-16: 위치 판정에 이미 반영된 GPS 오차범위를 상황판에도 같이 보여준다 — "위치
      // 불일치"인데 오차범위 자체가 컸는지(애매한 케이스)와 오차범위가 작은데도 멀리 떨어진 것인지
      // (명백한 불일치)를 관리자가 구분할 수 있게 한다.
      const effectiveLocationAccuracyMeters = bestLocationLogToday
        ? bestLocationLogToday.locationAccuracyMeters
        : (statusOnDay?.locationAccuracyMeters ?? checkinOnDay?.locationAccuracyMeters ?? null);
      // 2026-09-18: "불일치 건만 좌표 저장" 정책 — 위와 동일한 방식으로 "그 시점 판정에 쓰인 기록"
      // 기준으로 뽑는다(호출부(includeMismatchCoords=false)에서는 아예 안 내려줘서 관리자 외
      // 역할에는 응답 자체에 포함되지 않는다).
      const effectiveMismatchLatitude = includeMismatchCoords
        ? (bestLocationLogToday
            ? bestLocationLogToday.mismatchLatitude
            : (statusOnDay?.mismatchLatitude ?? checkinOnDay?.mismatchLatitude ?? null))
        : undefined;
      const effectiveMismatchLongitude = includeMismatchCoords
        ? (bestLocationLogToday
            ? bestLocationLogToday.mismatchLongitude
            : (statusOnDay?.mismatchLongitude ?? checkinOnDay?.mismatchLongitude ?? null))
        : undefined;

      // 2026-09-17: "위치 미확인"이 매일 10명 넘게 반복된다는 지적으로 원인을 다시 살펴보니,
      // 상당수가 GPS 정확도 문제가 아니라 그날 등록한 고객사 자체가 아직 시스템에 없거나(오타/신규
      // 임시등록) 등록은 돼 있어도 좌표가 비어있어서(attendance.routes.ts의 checkLocationMatch가
      // client를 못 찾거나 client.latitude/longitude가 null이면 그냥 null을 반환) 애초에 대조를
      // 시도조차 못 하는 경우였다. 지금까지는 이 경우와 "GPS 캡처 실패"가 똑같이 "위치 미확인"
      // 배지 하나로만 보여서 관리자가 원인을 구분할 방법이 없었다 — 여기서 실제로 어떤 경우인지
      // 판정해서 내려주면 프론트가 "이 고객사 좌표를 등록해주세요" 같은 구체적 조치를 안내할 수 있다.
      const isClientLocationStatus = statusOnDay?.status === 'CLIENT_MEETING' || statusOnDay?.status === 'CLIENT_WORK';
      let clientLocationDiagnosis: 'NO_CLIENT_MATCH' | 'CLIENT_NO_COORDS' | null = null;
      let clientLocationDiagnosisName: string | null = null;
      if (isClientLocationStatus && effectiveLocationMatch !== true && statusOnDay?.siteType !== 'REMOTE') {
        const effortForDiagnosis = fallbackEffort
          ?? await prisma.effortLog.findFirst({ where: { userId: u.id, workDate: workDateLabel }, orderBy: { startTime: 'desc' } });
        const diagnosisClientName = effortForDiagnosis?.clientName?.trim();
        if (diagnosisClientName) {
          // attendance.routes.ts와 동일한 방식(이름 부분일치, 대소문자 무시)으로 다시 찾아본다 —
          // 그 등록 순간에 어떤 지점(clientId)을 정확히 골랐는지는 저장돼 있지 않아 완벽히 같은
          // 결과를 보장할 순 없지만, "아예 없음/좌표 없음" 여부를 가리기엔 충분하다.
          const matchedClient = await prisma.client.findFirst({
            where: { name: { contains: diagnosisClientName, mode: 'insensitive' } },
          });
          if (!matchedClient) {
            clientLocationDiagnosis = 'NO_CLIENT_MATCH';
          } else if (matchedClient.latitude == null || matchedClient.longitude == null) {
            clientLocationDiagnosis = 'CLIENT_NO_COORDS';
          }
          clientLocationDiagnosisName = diagnosisClientName;
        }
      }

      return {
        userId: u.id,
        name: u.name,
        department: u.department.name,
        client: u.assignedClient?.name ?? null,
        workType: u.workType,
        status: statusOnDay?.status ?? null,
        statusChangedAt: statusOnDay?.changedAt ?? null,
        statusSource: statusOnDay?.source ?? null,
        statusNote: statusOnDay?.note ?? null,
        effortClientName: fallbackEffort?.clientName || null,
        locationMatch: effectiveLocationMatch,
        locationDistanceMeters: effectiveLocationDistanceMeters,
        locationAccuracyMeters: effectiveLocationAccuracyMeters,
        // 2026-09-02: locationMatch가 null인 이유를 상황판에서 구분해서 보여주기 위해 추가.
        // (1) 위치확인 자체를 안 하는 상태(재택/출장 등)라 애초에 시도조차 안 한 건지,
        // (2) 동의는 했는데 그 순간 캡처가 실패했는지(권한거부/시간초과 등, ResidentCheckin에는
        //     이 값이 없어 그 경우는 항상 null), (3) 애초에 동의를 안 해서 시도조차 못 한 건지 —
        // 프론트에서 이 값과 아래 동의 여부를 같이 보고 판단한다.
        // (2026-09-09: 위 bestLocationLogToday로 하루 중 확인 성공 이력이 있으면 이 값도 그
        // 성공 이력 기준(대개 'OK')으로 맞춰 내려간다 — 실제로는 확인됐는데 문구만 미확인으로
        // 보이는 걸 막기 위함.)
        locationCaptureStatus: effectiveLocationCaptureStatus,
        // 2026-09-18: 관리자(HR_ADMIN/SYSTEM_ADMIN) 요청일 때만 값이 채워진다(그 외엔 undefined라
        // 응답 JSON에서 아예 빠짐) — "위치 불일치" 건에 한해서만 값이 있고, 일치/미확인 건은 항상
        // null이다(buildMismatchCoords 원칙, common/location.ts 참고).
        mismatchLatitude: effectiveMismatchLatitude,
        mismatchLongitude: effectiveMismatchLongitude,
        // 2026-09-17: 위에서 계산한 "왜 위치대조가 아예 불가능했는지" 진단 — null이면 이 원인이
        // 아니라는 뜻(GPS 캡처 실패 등 기존 사유로 봐야 함).
        clientLocationDiagnosis,
        clientLocationDiagnosisName,
        // 2026-09-09: "원격"(재택/원격지원 등)으로 등록된 고객사미팅/작업은 현장에 있을 필요가
        // 없어서 attendance.routes.ts가 위치대조 자체를 건너뛴다 — 그 결과 locationMatch가 null로
        // 남는 게 정상인데, 프론트가 이 값을 몰라서 "위치 미확인"으로 잘못 flag하고 있었다(관리자
        // 문의로 발견, 예: 손세기 사원 코람코자산운용 "원격" 등록 건). 프론트에서 이 값을 보고
        // 원격 등록은 위치대조 대상에서 아예 제외하도록 내려준다.
        siteType: statusOnDay?.siteType ?? null,
        locationConsentGiven: u.locationConsentAt != null,
        privacyConsentGiven: u.privacyConsentAt != null,
        lastConfirmedAt: checkinOnDay?.lastConfirmedAt ?? null,
        clockedOut,
        clockOutAt: attendanceOnDay?.clockOutAt ?? null,
        // 2026-09-16: "출근" 버튼만 누르고 그날 상태를 직접 고른 적이 없어 잠정으로 HQ_WORKING이
        // 채워진 기록인지 여부 — 상황판(admin/dashboard.tsx)이 이 값을 보고 "본사근무로 확정됨"과
        // "아직 확인 대기중"을 구분해서 보여준다(라벨은 본사근무인데 거리는 수십km인 모순 표시 방지).
        isProvisional: statusOnDay?.note === PROVISIONAL_HQ_NOTE,
      };
    })
  );
  return board;
}
