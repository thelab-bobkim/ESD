import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly, ensureClockIn, combineDateTime, resolveEndTime, realDayWindow, applyAttendanceCorrection, checkMinWorkedMinutes, getLunchBreakMinutes, WORK_START_STATUSES, isWeekendKST, PROVISIONAL_HQ_NOTE } from '../../common/attendance-helpers';
import { recordNightWork } from '../../common/night-work-helpers';
import { recordEffort, findOpenEffort } from '../../common/effort-helpers';
import { checkLocationMatch, HQ_LOCATION_MATCH_RADIUS_METERS, buildMismatchCoords } from '../../common/location';
import { getPolicyNumber, getPolicyString, getPolicyJSON } from '../../common/policy-engine/policy-engine';

/** "123.45.67.0/24" 형태의 CIDR 표기를 IPv4 대역으로 해석해 clientIp가 그 안에 속하는지 본다. */
function ipInCidr(clientIp: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  if (!rangeIp || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const toInt = (ip: string): number | null => {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };
  const clientInt = toInt(clientIp);
  const rangeInt = toInt(rangeIp);
  if (clientInt == null || rangeInt == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (clientInt & mask) === (rangeInt & mask);
}

/** 허용 목록의 한 항목(정확한 IP 또는 "x.x.x.x/nn" CIDR 대역)과 클라이언트IP를 비교한다. */
function ipMatchesAllowedEntry(clientIp: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed || !clientIp) return false;
  return trimmed.includes('/') ? ipInCidr(clientIp, trimmed) : trimmed === clientIp;
}

/**
 * 사내망(공인IP) 기반 출근확인: 관리자가 정책값 HQ_ALLOWED_PUBLIC_IPS(JSON 문자열 배열, 예:
 * ["123.45.67.89", "210.115.22.0/24"] — 개별 IP와 CIDR 대역을 섞어서 등록 가능, 인터넷 회선이
 * 여러 개라 공인IP가 수십 개 쓰이는 사무실을 고려해 대역 표기를 지원한다, 2026-09-06)에 등록해둔
 * 사무실 공인IP와 이 요청의 실제 클라이언트 공인IP가 일치하면 "사내 와이파이에 연결되어 있다"고
 * 보고, GPS 오차·실패와 무관하게 본사근무 위치확인을 통과시킨다. req.ip는 nginx가 전달하는
 * X-Real-IP/X-Forwarded-For를 app.ts의 trust proxy 설정으로 이미 정확히 해석한 값이다. 브라우저에서
 * 실제 WiFi AP/MAC 주소를 스캔하는 것은 불가능하므로(2026-09 GPS 정확도 개선 검토 시 결론), 그
 * 대신 공인IP를 "사내망에 연결되어 있음"의 대리 지표로 쓴다.
 * 주의: 직원 휴대폰이 사내 와이파이가 아니라 셀룰러 데이터를 쓰는 중이면 이 방법은 통하지 않고
 * GPS 확인이 별도로 필요하다. 정책값이 비어있으면(관리자가 아직 설정 안 함) 항상 false를 반환해
 * 기존 GPS 기반 확인 동작을 그대로 유지한다.
 */
async function isRequestFromOfficeNetwork(req: Request, userId?: string): Promise<boolean> {
  const allowedIps = await getPolicyJSON<string[]>('HQ_ALLOWED_PUBLIC_IPS', []);
  const clientIp = (req.ip ?? '').replace(/^::ffff:/, ''); // IPv4-mapped IPv6 표기("::ffff:1.2.3.4") 정리
  const matched = allowedIps.length > 0 && allowedIps.some((entry) => ipMatchesAllowedEntry(clientIp, entry));
  // 기능이 실제로 의도대로 작동하는지(또는 IP가 예상과 다르게 잡히는지) 배포 후 바로 확인할 수 있도록
  // 남기는 진단 로그(등록된 IP 목록이 수십 개일 수 있어 개수만 남긴다).
  // 2026-09-09: 회사가 인터넷 회선을 여러 개 써서 공인IP가 30여 개나 되는데 정책엔 일부만
  // 등록돼 있어, 실제로 어떤 IP가 사무실 회선인지 관리자가 눈으로 구분하기 어려웠다(직원 개개인의
  // IP인지 사무실 공용 회선인지 알 수 없음). userId를 같이 남기면 나중에
  // `... | grep OfficeNetworkCheck | grep -oE "clientIp=[0-9.]+"`로 집계했을 때, 같은 IP에
  // 서로 다른 userId가 여러 명 몰려 있으면 "사무실 공용 회선"이고 한 사람만 계속 찍히면 "그
  // 개인의 자택/모바일 회선"이라고 구분할 수 있다.
  // `docker compose logs backend | grep OfficeNetworkCheck`로 확인 가능.
  console.log(
    `[OfficeNetworkCheck] userId=${userId ?? '(unknown)'} clientIp=${clientIp} allowedEntries=${allowedIps.length} matched=${matched}`
  );
  return matched;
}

/**
 * 카카오맵 역지오코딩 주소 매칭: 관리자가 정책값 HQ_ADDRESS_KEYWORDS(JSON 문자열 배열, 예:
 * ["신한이노플렉스", "테헤란로"])에 등록해둔 키워드 중 하나라도 이 요청의 주소 문자열에 포함되면
 * "본사 건물/블록 안에 있다"고 보고 GPS 거리와 무관하게 위치확인을 통과시킨다. 건물명(예:
 * "신한이노플렉스")과 도로명 주소(예: "테헤란로") 둘 다 키워드로 등록해두면 어느 쪽이든 하나만
 * 맞아도 통과된다. 주소 문자열 자체는 frontend가 카카오맵 SDK(coord2Address)로 이미 변환해서
 * 보내주는 값을 그대로 쓴다 — 백엔드에서 별도 역지오코딩 API 키를 새로 발급/설정할 필요가 없다.
 * (좌표를 이미 신뢰하는 것과 동일한 수준으로 신뢰하는 값이라, 별도의 서버측 재검증은 하지 않는다.)
 */
async function isHqAddressMatch(locationAddress: string | undefined): Promise<boolean> {
  if (!locationAddress) return false;
  const keywords = await getPolicyJSON<string[]>('HQ_ADDRESS_KEYWORDS', []);
  if (!keywords.length) return false;
  const normalizedAddress = locationAddress.replace(/\s+/g, '');
  return keywords.some((kw) => kw && normalizedAddress.includes(kw.replace(/\s+/g, '')));
}

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

// 이 상태로 바뀌면 "실제 업무 시작"으로 보고 출근시각을 자동 인식한다(주52시간제 대응).
// REMOTE(재택)는 대부분 고객사에 원격 접속해서 작업하는 형태라, 접속 시작~종료를 다른 근무
// 유형과 동일하게(고객사작업과 같은 방식으로) 추적하기 위해 포함시켰다.
// 2026-09-08: reports.routes.ts의 출근시각 불일치 경고(computeClockInMismatch)도 똑같은 기준을
// 써야 해서 attendance-helpers.ts로 옮기고 여기서는 그걸 그대로 가져다 쓴다(두 곳에 따로 두면
// 나중에 한쪽만 고치는 사고가 나기 쉬움).
// 이 상태는 프로젝트별 공수(工數) 기록 대상이다. REMOTE도 고객사작업과 동일하게 추적한다.
// 2026-09-06: WEEKEND_WORK도 실제 작업시간(시작~종료)을 EffortLog로 구조화해서 남겨야 나중에
// 리포트에서 집계할 수 있어 포함시켰다 — 다만 프론트의 동일한 이름의 상수(index.tsx
// EFFORT_STATUSES)에는 일부러 WEEKEND_WORK를 넣지 않았다(입력폼을 "프로젝트명" 항목 없이
// 야간작업과 똑같은 모양으로 유지하기 위함 — 프로젝트명은 항상 빈 값으로 저장됨). 이 두 상수는
// 이 상태를 빼고는 반드시 같은 값을 유지해야 한다.
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK']);
// 2026-09-15: EFFORT_STATUSES 중 "시작~완료"가 있는 실제 작업 세션 개념인 것들만 — 완료시간
// 없이(진행중) 등록했다가 나중에 이어받아 완료 처리할 수 있다(effort-helpers.ts recordEffort).
// 본사근무(HQ_WORKING)는 빼야 한다 — 애초에 완료시간 입력칸 자체가 없어 endTime이 항상 null인
// 하루 단위 상태라, 포함시키면 매일의 업무일지가 전부 최초 한 기록에 계속 덮어써지는 사고가 난다.
const EFFORT_CONTINUATION_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK']);
// 주말(토=6,일=0, KST) 여부 — "주말엔 주말작업만" 게이트 판단에 쓴다. 2026-09-14: reminder-scheduler.ts도
// 같은 기준이 필요해져서 attendance-helpers.ts로 옮기고 여기서는 그걸 그대로 가져다 쓴다.

// 위치이탈 자동감지(/departure-suggest, 2026-09-04)가 만든 제안임을 구분하는 표시 — 이 문자열로
// 시작하는 reason만 본인이 직접 확정/취소할 수 있다. 직원이 직접 신청한 지난 근무일 정정 요청은
// 이 표시가 없으므로 여전히 반드시 담당자 승인을 거쳐야 한다("본인 확인 없이 시스템이 임의로
// 근태를 확정하지 않는다"는 이 앱의 원칙 — attendance-correction.routes.ts 참고).
const AUTO_DEPARTURE_REASON_PREFIX = '[위치 자동감지]';

/** 위치이탈 자동감지가 만들어둔 대기중 제안이 있으면 취소(반려)한다 — 정상 퇴근 처리 시 정리용. */
async function cancelPendingAutoDepartureSuggestion(attendanceRecordId: string, actorUserId: string, comment: string) {
  const pending = await prisma.attendanceCorrectionRequest.findFirst({
    where: { attendanceRecordId, status: 'PENDING', reason: { startsWith: AUTO_DEPARTURE_REASON_PREFIX } },
  });
  if (!pending) return;
  await prisma.attendanceCorrectionRequest.update({ where: { id: pending.id }, data: { status: 'REJECTED' } });
  const approvalRequest = await prisma.approvalRequest.findUnique({ where: { attendanceCorrectionRequestId: pending.id } });
  if (approvalRequest && approvalRequest.status === 'PENDING') {
    await prisma.approvalRequest.update({
      where: { id: approvalRequest.id },
      data: { status: 'REJECTED', approverId: actorUserId, decidedAt: new Date(), comment },
    });
  }
}

/** 출근 처리(수동) — 위 자동인식 대상이 아닌 경우를 위한 수동 버튼 */
attendanceRouter.post('/clock-in', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  // 좌표는 저장하지 않고, 본사와의 거리 비교에만 즉시 사용하고 폐기한다.
  const location = req.body?.location as { lat: number; lng: number } | undefined;
  // 카카오맵 역지오코딩 주소(frontend에서 이미 변환해서 보내줌) — 좌표와 마찬가지로 대조 후 폐기.
  const locationAddress = req.body?.locationAddress as string | undefined;
  // 2026-09-16: 그 순간 GPS가 스스로 보고한 오차범위(미터) — /status와 동일하게 반경 판정에 반영한다.
  const rawAccuracyMeters = req.body?.accuracyMeters;
  const accuracyMeters = typeof rawAccuracyMeters === 'number' && Number.isFinite(rawAccuracyMeters) && rawAccuracyMeters >= 0
    ? rawAccuracyMeters
    : undefined;
  // 사내망(공인IP) 확인 — 회사 와이파이에 연결되어 있으면 아래 GPS 기반 위치확인들을 모두 통과시킨다.
  const officeNetworkConfirmed = await isRequestFromOfficeNetwork(req, userId);
  // 주소 매칭 확인 — 건물명/도로명 키워드가 맞으면 GPS 거리와 무관하게 통과시킨다.
  const hqAddressMatched = await isHqAddressMatch(locationAddress);
  const hqVerifiedByAlternateMeans = officeNetworkConfirmed || hqAddressMatched;

  const existing = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } });
  if (existing?.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_CLOCKED_IN', message: '이미 출근 처리되었습니다.' } });
  }

  // 직출(본사 미경유) 시 이동시간이 근로시간에 섞이지 않도록, "이동중" 상태에서는 수동 출근 등록을 막는다.
  // 고객사 도착 후 "고객사작업/고객사미팅" 등록 시 그 시점부터 자동으로 출근 처리된다.
  const { start: preDayStart, end: preDayEnd } = realDayWindow(workDate);
  const latestTodayStatus = await prisma.statusChangeLog.findFirst({
    where: { userId, changedAt: { gte: preDayStart, lt: preDayEnd } },
    orderBy: { changedAt: 'desc' },
  });
  if (latestTodayStatus?.status === 'MOVING') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'STILL_MOVING',
        message: '이동시간은 근로시간에 포함되지 않습니다. 고객사 도착 후 "고객사작업/고객사미팅"을 눌러주세요 — 그 시점부터 자동으로 출근 처리됩니다.',
      },
    });
  }

  // 2026-09-01 정책 변경: "출근" 버튼은 더 이상 위치확인 없이 조용히 통과시키지 않는다. 본사 좌표가
  // 등록되어 있다면 반드시 본사와 위치가 일치해야만 확정하고, 위치가 안 맞거나 아예 못 가져왔으면
  // 거부한 뒤 본사근무·고객사작업·고객사미팅·출장·고객사상주 중 실제 근무형태에 맞는 버튼을 눌러
  // 출근하도록 안내한다 — "출근 버튼만 누르고 방치"로 위치확인 없이 출근이 확정되던 허점을 없앤다.
  // (본사 좌표가 아예 등록 안 되어 있으면 애초에 검증 자체가 불가능하므로, 관리자 설정 누락으로
  // 전 직원의 출근을 막는 사고를 피하기 위해 예전처럼 위치확인 없이 통과시킨다.)
  const hqLat = await getPolicyString('HQ_LATITUDE', '');
  const hqLng = await getPolicyString('HQ_LONGITUDE', '');
  const hqConfigured = Boolean(hqLat && hqLng);
  let hqLocationResult: { locationMatch: boolean; locationDistanceMeters: number } | null = null;
  // 2026-09-09: 아래 GPS 좌표대조 블록은 hqVerifiedByAlternateMeans가 false일 때만 실행되는데,
  // true인 경우(사내망/주소로 이미 확인됨) hqLocationResult를 아무도 채워주지 않아서 계속 null로
  // 남아 있었다 — locationConfirmed(213번째 줄)는 맞게 true로 계산되는데 실제 기록되는
  // locationMatch는 null이라, "출근" 버튼으로 출근한 사람들이 사내망/주소로는 확인됐음에도 상황판엔
  // "위치 미확인"으로 표시되는 원인이었다(하단 hqLocationDebug 상태변경 핸들러엔 2026-09-08에 이미
  // 동일한 방식으로 고쳐져 있었는데, 이 "출근" 버튼 핸들러만 그 수정이 빠져 있었음 — 관리자 문의
  // "위치 미확인 다수" 재조사로 발견).
  if (hqConfigured && hqVerifiedByAlternateMeans) {
    hqLocationResult = { locationMatch: true, locationDistanceMeters: 0 };
  }
  // 사내망(공인IP) 또는 주소 매칭으로 이미 확인됐으면 GPS 위치확인 요구 자체를 건너뛴다.
  if (hqConfigured && !hqVerifiedByAlternateMeans) {
    if (!location) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'LOCATION_REQUIRED_FOR_CLOCKIN',
          message:
            '위치 확인이 되지 않아 "출근" 버튼으로는 출근을 확정할 수 없어요. 본사근무·고객사작업·고객사미팅·출장·고객사상주 중 실제 근무형태에 맞는 버튼을 눌러 출근해주세요.',
        },
      });
    }
    hqLocationResult = checkLocationMatch(location, { latitude: Number(hqLat), longitude: Number(hqLng) }, HQ_LOCATION_MATCH_RADIUS_METERS, accuracyMeters);
    // 2026-09-14: 김유범 피드백 — 고층건물 실내 GPS 오차(최대 2.8km 실측)로 본사에 실제로 있는데도
    // "출근" 버튼이 막히는 문제. /status의 본사근무 등록과 동일하게, 거리 불일치만으로는 막지 않고
    // locationMatch=false·거리값만 기록해서 상황판에서 확인 가능하게 한다(사내망/주소 매칭이라는
    // 다른 안전장치는 그대로 남아있음).
  }
  const locationConfirmed = hqConfigured && (hqVerifiedByAlternateMeans || Boolean(hqLocationResult?.locationMatch));

  const record = existing
    ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt: new Date() } })
    : await prisma.attendanceRecord.create({ data: { userId, workDate, clockInAt: new Date() } });

  // "출근"만 누르고 9개 상태 아이콘을 따로 안 고르면 계속 "상태 미확인"으로 남던 문제를 막기 위해,
  // 오늘 아직 상태를 하나도 안 골랐다면 일단 "본사근무"로 채워 넣는다. 위치가 실제로 확인된 경우
  // (locationConfirmed)엔 정식으로 확인된 본사근무로 남기고, 본사 좌표 미설정으로 검증을 못 한
  // 경우에만 예전처럼 "잠정" 표시를 남긴다(직원이 실제 상태를 고르면 그게 우선).
  const { start: dayStartReal, end: dayEndReal } = realDayWindow(workDate);
  const todayStatus = await prisma.statusChangeLog.findFirst({ where: { userId, changedAt: { gte: dayStartReal, lt: dayEndReal } } });
  if (!todayStatus) {
    const hqMismatchCoords = buildMismatchCoords(location, hqLocationResult);
    await prisma.statusChangeLog.create({
      data: {
        userId,
        status: 'HQ_WORKING',
        source: 'WEB',
        note: locationConfirmed ? null : PROVISIONAL_HQ_NOTE,
        locationMatch: hqLocationResult?.locationMatch ?? null,
        locationDistanceMeters: hqLocationResult?.locationDistanceMeters ?? null,
        locationAccuracyMeters: hqLocationResult ? (accuracyMeters ?? null) : null,
        locationCaptureStatus: location ? 'OK' : null,
        mismatchLatitude: hqMismatchCoords.mismatchLatitude,
        mismatchLongitude: hqMismatchCoords.mismatchLongitude,
      },
    });
  }

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'attendance_record', targetId: record.id, afterValue: { clockInAt: record.clockInAt, locationConfirmed } });

  return res.json({ success: true, data: { ...record, locationConfirmed } });
});

// 위치 확보 실패 사유 — 프론트가 이 값 중 하나로 보내면 그대로 저장한다. 안 보내거나(구버전 클라이언트)
// 목록에 없는 값이면 null(사유 미상)로 저장한다 — 과거 데이터와의 호환을 깨지 않기 위함.
const LOCATION_CAPTURE_STATUSES = new Set(['OK', 'NO_CONSENT', 'PERMISSION_DENIED', 'TIMEOUT', 'UNSUPPORTED', 'GEOCODE_FAILED']);

/** 퇴근 처리 — 그날의 "실질 근무"를 확정한다(주52시간 집계의 기준이 되는 실근무시간 계산) */
attendanceRouter.post('/clock-out', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  // 좌표는 절대 안 받고, 클라이언트에서 역지오코딩한 "주소 텍스트"만 받는다(직원 동의된 경우에만 전송됨).
  const clockOutLocation = typeof req.body?.locationAddress === 'string' ? req.body.locationAddress.slice(0, 200) : undefined;
  // 위치가 없을 때 "왜" 없는지(권한거부/타임아웃/미동의 등) — 상황판에서 빈 값과 구분해서 보여주기 위함.
  const rawLocationStatus = typeof req.body?.locationStatus === 'string' ? req.body.locationStatus : undefined;
  const clockOutLocationStatus = rawLocationStatus && LOCATION_CAPTURE_STATUSES.has(rawLocationStatus)
    ? (rawLocationStatus as 'OK' | 'NO_CONSENT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | 'GEOCODE_FAILED')
    : undefined;
  // 최소근무시간 미충족 상태에서 조기퇴근하는 경우 본인이 입력하는 사유(하드블록 대신 사용).
  const earlyLeaveReason = typeof req.body?.earlyLeaveReason === 'string' && req.body.earlyLeaveReason.trim()
    ? req.body.earlyLeaveReason.trim().slice(0, 300)
    : undefined;

  const existing = await prisma.attendanceRecord.findUnique({
    where: { userId_workDate: { userId, workDate } },
    include: { breakSessions: true },
  });
  if (!existing || !existing.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CLOCKED_IN', message: '출근 기록이 없습니다.' } });
  }
  if (existing.clockOutAt) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_CLOCKED_OUT', message: '이미 퇴근 처리되었습니다.' } });
  }

  // 출근 찍자마자 실수로(또는 급하게) 바로 퇴근을 눌러버리는 사고를 막기 위한 최소근무시간
  // (정책값, 기본 8시간). 예전엔 못 채우면 무조건 막았지만, 조기퇴근 사유를 입력하면 바로
  // 확정할 수 있게 바꿨다 — 부족분은 주간 누계에 그대로 반영되니(다른 날 초과분과 합산) 별도
  // 상쇄 계산 없이도 자연스럽게 맞춰진다.
  const minMinutes = (await getPolicyNumber('MIN_HOURS_BEFORE_CLOCKOUT', 8)) * 60;
  const elapsedMinutes = Math.round((Date.now() - existing.clockInAt.getTime()) / 60000);
  if (elapsedMinutes < minMinutes && !earlyLeaveReason) {
    const remain = minMinutes - elapsedMinutes;
    const remainH = Math.floor(remain / 60);
    const remainM = remain % 60;
    return res.status(400).json({
      success: false,
      error: {
        code: 'EARLY_LEAVE_REASON_REQUIRED',
        message: `아직 최소 근무시간을 채우지 않았습니다(${remainH}시간 ${remainM}분 부족). 조기퇴근 사유를 입력하시면 바로 퇴근 처리됩니다.`,
      },
    });
  }

  // 직출/직퇴(본사 미경유) 위치 필수 확인 — 회사 지휘감독 하 이동(출장 등)을 제외하고,
  // 서울·경기 등 대중교통 이동은 근로시간에 포함되지 않으므로 최종 고객사에서 퇴근을 찍을 때
  // 실제 위치가 확인되어야 정확한 근무시간을 산출할 수 있다. 오늘 마지막으로 등록한 상태를 기준으로 판단한다.
  const { start: clockOutDayStart, end: clockOutDayEnd } = realDayWindow(workDate);
  const latestStatusToday = await prisma.statusChangeLog.findFirst({
    where: { userId, changedAt: { gte: clockOutDayStart, lt: clockOutDayEnd } },
    orderBy: { changedAt: 'desc' },
  });
  const requiresLocation = !!latestStatusToday && (
    REQUIRE_LOCATION_ON_CLOCKOUT_ALWAYS.has(latestStatusToday.status)
    || (REQUIRE_LOCATION_ON_CLOCKOUT_IF_ONSITE.has(latestStatusToday.status) && latestStatusToday.siteType === 'ONSITE')
  );
  if (requiresLocation && clockOutLocationStatus !== 'OK') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'LOCATION_REQUIRED_FOR_CLOCKOUT',
        message: '고객사 현장에서 퇴근하는 경우 위치 확인이 필수입니다. 위치 접근을 허용한 뒤 다시 시도해주세요.',
      },
    });
  }

  const clockOutAt = new Date();

  // 정규 퇴근 마감: 정규 근무 상태(야간작업 제외)로 저녁 경고시각(기본 19시) 이후까지 퇴근을 안 누르면,
  // 막지는 않되 정규 근무시간은 마감시각(기본 18시)까지만 인정하고 그 이후분은 "야간작업으로 별도
  // 등록해달라"고 안내한다(자동으로 야간작업 세션을 만들지는 않는다 — 본인 확인 없이 시스템이 임의로
  // 근태를 확정하지 않는다는 원칙을 그대로 지키기 위함. 프론트에서 확인 배너로 등록을 유도한다).
  const regularWorkEndHour = await getPolicyNumber('REGULAR_WORK_END_HOUR', 18);
  const lateClockOutWarnHour = await getPolicyNumber('LATE_CLOCKOUT_WARN_HOUR', 19);
  const regularCutoffTime = combineDateTime(workDate, `${String(regularWorkEndHour).padStart(2, '0')}:00`);
  const lateWarnTime = combineDateTime(workDate, `${String(lateClockOutWarnHour).padStart(2, '0')}:00`);
  // 2026-09-06: 주말작업(WEEKEND_WORK)도 애초에 "평일 09~18시 정규근무"라는 전제가 없는 별도
  // 근무형태라 야간작업과 동일하게 이 마감시각 계산에서 제외한다 — 안 그러면 토요일에 오래
  // 일하고 늦게 퇴근했을 때 "정규 근무시간 초과"로 잘못 계산되어 버린다.
  const isNightWorkDay = latestStatusToday?.status === 'NIGHT_WORK' || latestStatusToday?.status === 'WEEKEND_WORK';
  let lateClockOutOverMinutes = 0;
  let regularWorkEndAt = clockOutAt;
  if (!isNightWorkDay && clockOutAt > lateWarnTime) {
    const cappedAt = existing.clockInAt > regularCutoffTime ? existing.clockInAt : regularCutoffTime;
    lateClockOutOverMinutes = Math.round((clockOutAt.getTime() - cappedAt.getTime()) / 60000);
    if (lateClockOutOverMinutes > 0) {
      regularWorkEndAt = cappedAt;
    } else {
      lateClockOutOverMinutes = 0;
    }
  }

  const totalBreakMinutes = existing.breakSessions.reduce((sum, b) => {
    if (!b.endAt) return sum;
    return sum + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000);
  }, 0);
  const grossMinutes = Math.round((regularWorkEndAt.getTime() - existing.clockInAt.getTime()) / 60000);
  // 2026-09-14: 점심시간 1시간은 근무시간이 아니므로 항상 공제한다(applyAttendanceCorrection과
  // 동일한 정책값 사용 — attendance-helpers.ts의 getLunchBreakMinutes() 참고).
  const lunchBreakMinutes = await getLunchBreakMinutes();
  const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes - lunchBreakMinutes);

  const record = await prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      clockOutAt,
      totalWorkedMinutes,
      ...(clockOutLocation ? { clockOutLocation } : {}),
      ...(clockOutLocationStatus ? { clockOutLocationStatus } : {}),
      ...(earlyLeaveReason ? { earlyLeaveReason } : {}),
    },
  });

  // "퇴근" 버튼으로 정상 처리됐으니, 혹시 위치이탈 자동감지가 미리 만들어둔 대기중 제안(있다면)은
  // 더 이상 의미가 없다 — 승인함에 오탐(false positive)으로 남지 않도록 같이 정리한다.
  await cancelPendingAutoDepartureSuggestion(existing.id, userId, '본인이 정상적으로 "퇴근" 버튼을 눌러 처리됨');

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'attendance_record', targetId: record.id, afterValue: { clockOutAt, totalWorkedMinutes, lateClockOutOverMinutes } });

  const lateClockOutSuggestion = lateClockOutOverMinutes > 0
    ? {
        overMinutes: lateClockOutOverMinutes,
        cutoffHour: regularWorkEndHour,
        suggestedStart: regularWorkEndAt.toISOString(),
        suggestedEnd: clockOutAt.toISOString(),
      }
    : null;

  return res.json({ success: true, data: record, lateClockOutSuggestion });
});

const effortSchema = z.object({
  clientName: z.string().optional(),
  // 프론트 콤보박스에서 목록의 특정 고객사를 골랐을 때 그 id를 함께 보낸다. 같은 이름을 포함하는
  // 지점이 여러 곳(예: "김앤장법률사무소" 본점/세양센터/국원센터)이면 이름만으로는 어느 지점인지
  // 특정할 수 없어 findFirst가 아무 지점이나 골라버릴 수 있었다 — id가 오면 그걸로 정확히 그
  // 지점만 조회한다(2026-09-08, 관리자 문의로 발견). 목록에 없는 새 이름을 직접 입력한 경우 등
  // id가 없을 때는 기존처럼 이름 부분일치로 대체 조회한다.
  clientId: z.string().optional(),
  projectName: z.string().optional(),
  workType: z.string().optional(),
  startTime: z.string().optional(), // "HH:MM" (KST)
  endTime: z.string().optional(), // "HH:MM" (KST), 없으면 진행중
  // 2026-09-15: 박준영/이보용 피드백 — 완료시간이 필수인 상태(REQUIRE_END_TIME_STATUSES)라도,
  // 프론트에서 "진행중" 체크박스를 명시적으로 켜서 보낸 경우엔 이 값이 true로 온다. 단순히
  // 완료시간 입력을 깜빡한 것과 구분하기 위한 용도이며, 실제 완료시간 필수 여부 판단(아래
  // REQUIRE_END_TIME_STATUSES 블록)에만 쓰인다.
  inProgress: z.boolean().optional(),
  description: z.string().optional(),
  // 작업인원(본인 외 추가 투입 인원)·진행률/차수 — 별도 컬럼 없이 description에 합쳐서 저장한다
  // (야간작업/고객사작업 보고서에서 흔히 같이 적는 항목이라 자유서술 설명에 자연스럽게 붙는다).
  personnel: z.string().optional(),
  progressStage: z.string().optional(),
});

/** effort.description + 작업인원/진행률·차수를 사람이 읽기 좋은 하나의 텍스트로 합친다. */
function composeEffortDescription(effort: z.infer<typeof effortSchema>): string | undefined {
  const lines: string[] = [];
  if (effort.description) lines.push(effort.description);
  if (effort.personnel) lines.push(`작업인원: ${effort.personnel}`);
  if (effort.progressStage) lines.push(`진행률/차수: ${effort.progressStage}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

const businessTripSchema = z.object({
  destination: z.string().min(1),
  purpose: z.string().min(1),
  startAt: z.string().min(1), // ISO datetime-local 문자열
  endAt: z.string().optional(),
});

const statusSchema = z.object({
  status: z.enum([
    'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'MEETING', 'MOVING', 'REMOTE', 'NIGHT_WORK', 'WEEKEND_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'CLIENT_MEETING', 'CLIENT_WORK', 'BUSINESS_TRIP',
  ]),
  note: z.string().optional(),
  effort: effortSchema.optional(),
  businessTrip: businessTripSchema.optional(),
  // 고객사미팅/고객사작업 등록 시 그 순간의 좌표(대조 후 즉시 폐기, 저장 안 함)
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  // 위치를 못 가져온 이유(권한거부/타임아웃/미동의 등) — location이 없을 때만 의미 있음.
  // clock-out과 동일한 값 목록(LOCATION_CAPTURE_STATUSES)을 그대로 사용한다.
  locationStatus: z.string().optional(),
  // 2026-09-16: 그 순간 GPS가 스스로 보고한 오차범위(미터, frontend geolocation.ts가 이미 계산해
  // 갖고 있던 값) — location이 있을 때만 의미 있음. common/location.ts의 checkLocationMatch가
  // 반경 판정에 반영한다(위치 미확인/불일치 개선 1순위).
  accuracyMeters: z.number().nonnegative().optional(),
  // 카카오맵 역지오코딩 주소(frontend에서 변환) — 본사근무 등록 시 건물명/도로명 키워드 매칭용.
  locationAddress: z.string().optional(),
  // 원격/현장 — 고객사미팅/고객사작업/야간작업 등록 시 필수. 상태 종류와 무관하게 항상
  // status_change_logs에 저장되며(EffortLog/NightWorkSession은 상태별로 나뉘어 있어 조회가 불편함),
  // 퇴근 처리 시 "직출/직퇴라 위치 필수" 판단에 이 값을 사용한다.
  siteType: z.enum(['REMOTE', 'ONSITE']).optional(),
});

// 이 상태들만 GPS 위치대조 대상이다(고객사 위치와 비교할 대상이 있는 경우만).
// REMOTE(재택)는 집에서 원격 접속하는 게 정상이라 위치대조 대상에 넣지 않는다(의도적 제외).
const LOCATION_CHECK_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);
// 이 상태들은 "원격/현장"을 반드시 골라야 한다 — 야간작업 보고서에도 현장 여부가 필요하고
// (VERITAS 등 상주 백업팀의 야간 현장작업 사례), 고객사미팅/작업은 아래 직출퇴 판단에도 쓰인다.
const REQUIRE_SITE_TYPE_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK']);
// 이 상태 + 현장(ONSITE)이면 "직출/직퇴"로 보고, 최종 퇴근 시 위치 등록을 필수로 한다.
// 이동중/야간작업/본사근무/출장(회사 지휘감독 하 이동)은 제외한다.
const REQUIRE_LOCATION_ON_CLOCKOUT_IF_ONSITE = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);
// 상주근무(RESIDENT_ONSITE)는 정의상 항상 고객사 현장이라 siteType 여부와 무관하게 항상 포함한다.
const REQUIRE_LOCATION_ON_CLOCKOUT_ALWAYS = new Set(['RESIDENT_ONSITE']);
// "정규 출근"으로 취급하는 상태 — 야간작업(NIGHT_WORK)은 제외. 저녁 정책시각 이후엔 이 상태들로
// 출근을 새로 찍을 수 없고, 대신 야간작업으로 등록하도록 안내한다(REGULAR_WORK_END_HOUR 정책값).
// REMOTE도 이제 정규 근무시간 추적 대상이라 포함한다.
const REGULAR_CLOCK_IN_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'BUSINESS_TRIP', 'REMOTE']);

/** 현재 상태 변경. 업무 시작류 상태면 출근시각을 자동 인식하고, 고객사미팅/작업이면 공수기록도 남긴다. */
attendanceRouter.post('/status', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '상태값을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const { status, note, effort, location, businessTrip, siteType, locationStatus: rawLocationStatus, locationAddress, accuracyMeters } = parsed.data;

  // 주말(토/일, KST) 게이트(2026-09-06 요청): 주말엔 "주말작업"만 등록할 수 있고 나머지 상태는
  // 막는다 — 반대로 평일엔 "주말작업"을 등록할 수 없다. 관리자 계정도 예외 없이 적용한다(프론트
  // 아이콘 잠금은 관리자 계정에는 안 걸어두지만, 실제 등록은 여기서 최종적으로 검증되므로 관리자가
  // 테스트 삼아 눌러도 이 규칙은 그대로 지켜진다).
  const isWeekendNow = isWeekendKST();
  if (isWeekendNow && status !== 'WEEKEND_WORK') {
    return res.status(400).json({
      success: false,
      error: { code: 'WEEKEND_ONLY_WEEKEND_WORK', message: '주말에는 "주말작업" 상태만 등록할 수 있습니다.' },
    });
  }
  if (!isWeekendNow && status === 'WEEKEND_WORK') {
    return res.status(400).json({
      success: false,
      error: { code: 'WEEKEND_WORK_ONLY_ON_WEEKEND', message: '주말작업은 토요일/일요일에만 등록할 수 있습니다.' },
    });
  }

  // 아래 let 재할당(사내망 확인 시 'OK'로 덮어쓰기) 때문에 const로 두면 안 되는데, let은 리터럴 타입을
  // string으로 넓혀버려서(literal widening) 이 값을 그대로 Prisma의 LocationCaptureStatus enum
  // 필드에 넣을 때 타입이 안 맞게 된다 — 명시적으로 타입을 지정해서 넓혀지지 않게 고정한다.
  let locationCaptureStatus: 'OK' | 'NO_CONSENT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | 'GEOCODE_FAILED' | undefined = location
    ? 'OK'
    : rawLocationStatus && LOCATION_CAPTURE_STATUSES.has(rawLocationStatus)
      ? (rawLocationStatus as 'NO_CONSENT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | 'GEOCODE_FAILED')
      : undefined;
  // 사내망(공인IP) 확인 — 본사근무 등록 시 GPS 없이도(또는 GPS가 빗나가도) 위치확인을 통과시킨다.
  const officeNetworkConfirmed = status === 'HQ_WORKING' ? await isRequestFromOfficeNetwork(req, userId) : false;
  // 주소 매칭 확인 — 건물명/도로명 키워드가 맞으면 GPS 거리와 무관하게 통과시킨다.
  const hqAddressMatched = status === 'HQ_WORKING' ? await isHqAddressMatch(locationAddress) : false;
  const hqVerifiedByAlternateMeans = officeNetworkConfirmed || hqAddressMatched;
  if (hqVerifiedByAlternateMeans) {
    // 위치가 사내망 또는 주소 매칭으로 확인됐으니, 이후 로직·집계(예: priorHqLocationFailures)가
    // "위치 확인됨"으로 일관되게 취급하도록 캡처상태를 OK로 남긴다.
    locationCaptureStatus = 'OK';
  }

  // 출장은 목적지/기간/목적이 필수다(계획된 정보라 즉시 확정해서 남긴다).
  if (status === 'BUSINESS_TRIP' && !businessTrip) {
    return res.status(400).json({ success: false, error: { code: 'BUSINESS_TRIP_REQUIRED', message: '목적지·출발일시·목적을 모두 입력해야 합니다.' } });
  }

  // 고객사미팅/고객사작업/야간작업/재택은 작업시작 시간만 있으면 등록 가능하다(막 시작한 시점엔 완료시간을
  // 알 수 없는 게 당연하므로). 완료시간은 나중에 다시 등록해서 채우면 된다("진행중" 허용).
  const REQUIRE_TIME_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'REMOTE', 'WEEKEND_WORK']);
  if (REQUIRE_TIME_STATUSES.has(status) && !effort?.startTime) {
    return res.status(400).json({ success: false, error: { code: 'TIME_REQUIRED', message: '작업시작 시간을 입력해야 합니다.' } });
  }

  // 2026-09-14: "고객작업과 야간작업 주말작업은 모두 시작시간과 끝나는 시간이 있어야 됩니다" 요청
  // 반영 — 이 세 상태는 완료시간도 필수다(고객사미팅은 요청에서 제외되어 기존처럼 "진행중" 허용).
  // 다만 이 검증은 상세폼 제출(effort.description이 있는 등록)에만 건다 — 아이콘을 한 번 눌러
  // 상태를 즉시 등록하는 최초 클릭(QUICK_REGISTER_STATUSES, 프론트 index.tsx)은 description 없이
  // 시작시간만 보내고, 바로 이어서 열리는 상세폼에서 완료시간을 채우는 구조이므로 그 즉시등록
  // 자체까지 막으면 안 된다.
  // 2026-09-15: 박준영("고객사 작업이 언제 끝날지 모르는 상황") / 이보용 피드백 — 완료시간
  // 필수 정책 자체는 유지하되, 프론트의 "진행중" 체크박스(effort.inProgress)를 명시적으로 켜서
  // 보낸 경우에는 완료시간 없이도 등록을 허용한다(작업이 끝나면 다시 상태변경으로 완료시간까지
  // 채워 등록하도록 프론트에서 안내).
  const REQUIRE_END_TIME_STATUSES = new Set(['CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK']);
  if (REQUIRE_END_TIME_STATUSES.has(status) && effort?.description && !effort?.endTime && !effort?.inProgress) {
    return res.status(400).json({ success: false, error: { code: 'END_TIME_REQUIRED', message: '완료 시간을 입력해야 합니다.' } });
  }

  // 고객사작업/고객사미팅은 어떤 고객사인지 반드시 알아야 공수 산정·리포트가 의미가 있다
  // (2026-09-02: 빈칸으로 저장되던 기록이 리포트에서 통째로 누락되는 문제 해결 — 사용자 확인 완료).
  // 등록된 고객사 목록에서 고른 이름이어야 하며, 목록에 없는 새 이름이면 프론트에서 먼저
  // POST /attendance/clients로 등록한 뒤 그 이름을 넘겨야 한다.
  if (LOCATION_CHECK_STATUSES.has(status) && !effort?.clientName?.trim()) {
    return res.status(400).json({ success: false, error: { code: 'CLIENT_NAME_REQUIRED', message: '고객사를 선택해야 합니다.' } });
  }

  // 원격/현장 — 고객사미팅/고객사작업/야간작업은 필수 선택. 미선택이면 등록 자체를 막는다.
  if (REQUIRE_SITE_TYPE_STATUSES.has(status) && !siteType) {
    return res.status(400).json({ success: false, error: { code: 'SITE_TYPE_REQUIRED', message: '작업위치(원격/현장)를 선택해야 합니다.' } });
  }

  // 정규 출근 시각 제한: 저녁 정책시각(기본 18시, KST) 이후에 아직 오늘 출근이 안 찍힌 상태에서
  // 정규 근무류 상태를 등록하려 하면 막고 "야간작업"으로 등록하도록 안내한다. 이미 정상적으로
  // 출근한 뒤 저녁에 상태만 바꾸는 경우까지 막을 이유는 없어서 "출근 전"인 경우에만 적용한다.
  if (REGULAR_CLOCK_IN_STATUSES.has(status)) {
    const workDateForClockIn = todayDateOnly();
    const existingRecordForClockIn = await prisma.attendanceRecord.findUnique({
      where: { userId_workDate: { userId, workDate: workDateForClockIn } },
    });
    if (!existingRecordForClockIn?.clockInAt) {
      const cutoffHour = await getPolicyNumber('REGULAR_WORK_END_HOUR', 18);
      const kstHour = (new Date().getUTCHours() + 9) % 24;
      if (kstHour >= cutoffHour) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'LATE_CLOCKIN_USE_NIGHT_WORK',
            message: `${cutoffHour}시 이후에는 정규 출근으로 등록할 수 없습니다. "야간작업"으로 등록해주세요.`,
          },
        });
      }
    }
  }

  // 야간작업 시각 제한(2026-09-04, 관리자 요청): 낮 시간에도 "야간작업"으로 등록하는 직원이 있어서,
  // 위 정규 출근 마감시각과 같은 정책값(기본 18시, KST)을 기준으로 그 이전에는 야간작업 등록 자체를
  // 막는다. 위와 같은 정책값을 그대로 재사용해서 "정규근무/야간작업의 경계 시각"이 한 곳(관리자
  // 정책설정)에서만 관리되게 했다 — 따로 두면 둘이 어긋날 수 있어서다.
  if (status === 'NIGHT_WORK') {
    const nightWorkStartHour = await getPolicyNumber('REGULAR_WORK_END_HOUR', 18);
    const kstHourForNightWork = (new Date().getUTCHours() + 9) % 24;
    // 하루 경계(새벽 3시 — todayDateOnly()/realDayWindow()와 동일한 기준)를 함께 고려해야 한다.
    // 저녁 마감시각(기본 18시)부터 다음날 새벽 3시 전까지를 "밤 시간대"로 보고 허용하고, 그 사이
    // (새벽 3시~마감시각 전, 예: 03~17시)만 차단한다 — 자정을 넘겨 계속 일하는 야간작업자가
    // 새벽에도 상태를 등록/수정할 수 있어야 하므로, 단순히 "마감시각 이전"만으로 판단하면 안 된다.
    const DAY_BOUNDARY_HOUR = 3;
    const isNightWindow = kstHourForNightWork >= nightWorkStartHour || kstHourForNightWork < DAY_BOUNDARY_HOUR;
    if (!isNightWindow) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'TOO_EARLY_FOR_NIGHT_WORK',
          message: `야간작업은 ${nightWorkStartHour}시 이후부터 등록할 수 있습니다. 지금 시간대는 실제 근무형태(본사근무·고객사작업·고객사미팅 등)로 등록해주세요.`,
        },
      });
    }
  }

  // 본사근무 등록: 위치정보가 있고 본사 좌표가 등록되어 있는데 본사와 멀리 떨어져 있으면,
  // "출근" 버튼과 동일하게 본사근무 등록 자체를 막고 고객사미팅/고객사작업으로 유도한다.
  // 고객사작업/미팅과 동일한 원칙 — 위치는 잡혔는데 실제로 멀면 항상 차단하고, 위치 확보
  // 자체가 실패(권한거부/타임아웃/미동의 등)했으면 오늘 첫 실패는 봐주되 그 다음부터는 실제
  // 위치 일치를 요구한다. 이게 없으면 위치를 안 주는 것만으로 검증이 통째로 무력화된다.
  let hqLocationResult: { locationMatch: boolean; locationDistanceMeters: number } | null = null;
  // 사내망 공인IP·주소 키워드로 이미 본사임이 확인된 경우: 아래 좌표 대조 블록 자체를 건너뛰기만
  // 하고 끝내면(과거 버그), 이 기록의 locationMatch가 계속 null로 남아 상황판에서 "위치 미확인"으로
  // 잘못 표시된다(2026-09-08, 관리자가 "본사에 다 있는데 왜 위치확인이 안 되냐" 문의 — 서버 로그로
  // location_capture_status='OK'인데 location_match가 null인 기록이 실제로 다수 확인되어 원인 특정).
  // 좌표 대조를 아예 안 해도 이미 확인된 것이므로, 여기서 명시적으로 "확인됨"을 남겨야 한다.
  if (status === 'HQ_WORKING' && hqVerifiedByAlternateMeans) {
    hqLocationResult = { locationMatch: true, locationDistanceMeters: 0 };
  }
  if (status === 'HQ_WORKING' && !hqVerifiedByAlternateMeans) {
    const hqLat = await getPolicyString('HQ_LATITUDE', '');
    const hqLng = await getPolicyString('HQ_LONGITUDE', '');
    if (hqLat && hqLng) {
      hqLocationResult = checkLocationMatch(location, { latitude: Number(hqLat), longitude: Number(hqLng) }, HQ_LOCATION_MATCH_RADIUS_METERS, accuracyMeters);
      // 2026-09-14: 김유범 피드백 — 신한이노플렉스 등 고층건물 실내에서는 GPS가 최대 2.8km까지도
      // 빗나가는 사례가 실제로 있어(반경을 1km까지 넓혀도 여전히 벗어남), 거리 불일치만으로
      // 본사근무 등록 자체를 막지 않는다. 2026-09-08에 고객사미팅/고객사작업에는 이미 적용한
      // "막지 않고 locationMatch=false·거리값만 기록" 완화를 본사근무에도 동일하게 적용한다
      // (locationMismatchException 패턴 참고). 사내망 IP·주소 매칭이라는 다른 안전장치는 여전히
      // 남아있고, 위치 자체가 순간이동급으로 튄 경우는 프론트에서 별도로 차단한다(jumpDetected).
      if (!hqLocationResult) {
        const { start: dayStartForHq, end: dayEndForHq } = realDayWindow(todayDateOnly());
        const priorHqLocationFailures = await prisma.statusChangeLog.count({
          where: {
            userId,
            status: 'HQ_WORKING',
            changedAt: { gte: dayStartForHq, lt: dayEndForHq },
            locationCaptureStatus: { notIn: ['OK'] },
          },
        });
        if (priorHqLocationFailures >= 1) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'LOCATION_REQUIRED',
              message: '오늘 이미 한 번 위치 확인 없이 본사근무로 등록하셨어요. 이번엔 위치 접근을 허용한 뒤 다시 시도해주세요.',
            },
          });
        }
      }
    }
  }

  if (status === 'HQ_WORKING') {
    // 2026-09-08: 사내망 확인이 실패했는데도 캡처상태는 'OK'로 남고 locationMatch는 계속 비어(null)
    // 있는 사례가 관리자 문의로 발견됐다. 코드 흐름상 재현되지 않아야 하는 조합이라, 다음 발생 시
    // 바로 원인을 특정할 수 있도록 판정에 쓰인 입력값과 결과를 함께 남긴다.
    // `docker compose logs backend | grep HqLocationDebug`로 확인.
    // eslint-disable-next-line no-console
    console.log(
      `[HqLocationDebug] userId=${userId} officeNetworkConfirmed=${officeNetworkConfirmed} hqAddressMatched=${hqAddressMatched} hasLocation=${Boolean(location)} rawLocationStatus=${rawLocationStatus ?? '(none)'} locationCaptureStatus=${locationCaptureStatus ?? '(none)'} hqLocationResult=${JSON.stringify(hqLocationResult)}`
    );
  }

  // 위치대조: 등록된 고객사 좌표와 비교한다. 목록에서 정확히 고른 고객사면 effort.clientId로
  // 그 지점만 정확히 조회하고, id가 없으면(자유입력·구버전 클라이언트 등) 기존처럼 이름
  // 부분일치로 대체 조회한다. 매칭되는 고객사가 없거나 좌표 미등록이면 대조할 대상이 없으니
  // 그냥 null(확인 안 함)로 둔다.
  // 2026-09-08: 이름 부분일치만 쓰던 예전 방식은, "김앤장법률사무소"처럼 본점 외에 "김앤장법률사무소
  // 세양센터/국원센터"같이 같은 문자열을 포함하는 지점이 여러 곳 등록돼 있으면 findFirst가 그중
  // 아무 지점이나(등록 순서상 먼저 걸리는 곳) 골라버려서, 실제로는 다른 지점에 있는데도 엉뚱한
  // 지점 좌표와 비교돼 위치가 어긋나 보일 수 있었다(관리자 문의로 발견). id 기반 조회를 우선해서
  // 이 모호함을 없앤다.
  // 2026-09-06: "원격"으로 진행하는 고객사작업/미팅(예: 이동중에 급히 원격지원하는 경우)까지
  // 고객사 현장 좌표와 비교하면, 실제로 현장에 없는 게 정상인데도 "위치 불일치"로 막혀버린다
  // (사용자 지적 — 이동중 긴급 원격작업 검토 중 발견). siteType이 원격이면 애초에 현장에 있을
  // 필요가 없으므로, 이 경우엔 위치대조 자체를 하지 않는다(현장/ONSITE만 기존처럼 대조).
  let locationResult: { locationMatch: boolean; locationDistanceMeters: number } | null = null;
  let matchedClientForLocation: { latitude: number | null; longitude: number | null } | null = null;
  if (LOCATION_CHECK_STATUSES.has(status) && effort?.clientName && siteType !== 'REMOTE') {
    matchedClientForLocation = effort.clientId
      ? await prisma.client.findUnique({ where: { id: effort.clientId } })
      : await prisma.client.findFirst({
          where: { name: { contains: effort.clientName.trim(), mode: 'insensitive' } },
        });
    locationResult = checkLocationMatch(location, matchedClientForLocation, undefined, accuracyMeters);
  }

  // 등록된 고객사 좌표가 있는 경우에만 강제한다(현장 사칭 방지).
  // - 위치 확보 자체가 실패(권한거부/타임아웃 등)했으면: 오늘 첫 실패는 봐주고 통과시키되,
  //   이미 한 번 봐준 뒤부터는 실제로 위치가 일치해야만 통과시킨다.
  // - 위치는 잡혔는데 실제 거리가 멀면: 2026-09-08 이전에는 몇 번을 시도해도 항상 차단했는데,
  //   등록된 고객사 좌표는 맞는데도 실내 GPS 오차·근사위치 설정 등으로 정상적으로 그 자리에
  //   있으면서도 계속 막히는 사례가 실제로 발생해(관리자 확인 요청) 막지는 않되, locationMatch=false·
  //   거리값을 그대로 기록해 상황판에 "위치 불일치"로 표시되게 한다 — 관리자가 필요시 사후 확인.
  let locationMismatchException = false;
  if (LOCATION_CHECK_STATUSES.has(status) && matchedClientForLocation?.latitude != null && matchedClientForLocation?.longitude != null) {
    if (locationResult && !locationResult.locationMatch) {
      locationMismatchException = true;
    }
    if (!locationResult) {
      const { start: dayStartForLocation, end: dayEndForLocation } = realDayWindow(todayDateOnly());
      const priorLocationFailures = await prisma.statusChangeLog.count({
        where: {
          userId,
          status: { in: ['CLIENT_MEETING', 'CLIENT_WORK'] },
          changedAt: { gte: dayStartForLocation, lt: dayEndForLocation },
          locationCaptureStatus: { notIn: ['OK'] },
        },
      });
      if (priorLocationFailures >= 1) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'LOCATION_REQUIRED',
            message: '오늘 이미 한 번 위치 확인 없이 등록하셨어요. 이번엔 위치 접근을 허용한 뒤 고객사 현장에서 다시 시도해주세요.',
          },
        });
      }
    }
  }

  const statusMismatchCoords = buildMismatchCoords(location, locationResult ?? hqLocationResult);
  const log = await prisma.statusChangeLog.create({
    data: {
      userId,
      status,
      note,
      source: 'WEB',
      locationMatch: (locationResult ?? hqLocationResult)?.locationMatch ?? null,
      locationDistanceMeters: (locationResult ?? hqLocationResult)?.locationDistanceMeters ?? null,
      // 2026-09-16: 대조가 실제로 이뤄진 경우(locationResult/hqLocationResult가 있는 경우)에만
      // 남긴다 — 위치대조 자체를 안 하는 상태(재택 등)에는 accuracyMeters가 와도 의미가 없다.
      locationAccuracyMeters: (locationResult ?? hqLocationResult) ? (accuracyMeters ?? null) : null,
      siteType: siteType ?? null,
      locationCaptureStatus: (LOCATION_CHECK_STATUSES.has(status) || status === 'HQ_WORKING') ? (locationCaptureStatus ?? null) : null,
      mismatchLatitude: statusMismatchCoords.mismatchLatitude,
      mismatchLongitude: statusMismatchCoords.mismatchLongitude,
    },
  });

  if (WORK_START_STATUSES.has(status)) {
    await ensureClockIn(userId);
  }

  let effortLog = null;
  if (EFFORT_STATUSES.has(status) && effort) {
    const workDate = todayDateOnly();
    const startTime = effort.startTime ? combineDateTime(workDate, effort.startTime) : new Date();
    const endTime = effort.endTime ? resolveEndTime(startTime, combineDateTime(workDate, effort.endTime)) : null;
    const effortData = {
      workDate,
      clientName: effort.clientName || '',
      projectName: effort.projectName || '',
      workType: effort.workType || '기타',
      startTime,
      endTime,
      description: composeEffortDescription(effort),
    };
    // 2026-09-15: "진행중"으로 남겨둔 기록이 있으면 새로 만들지 않고 이어받아 완료 처리한다
    // (effort-helpers.ts recordEffort 참고, 박준영/이보용 피드백). 본사근무는 이 개념이 없어 제외.
    effortLog = EFFORT_CONTINUATION_STATUSES.has(status)
      ? await recordEffort(userId, status, effortData)
      : await prisma.effortLog.create({ data: { userId, ...effortData, sourceStatus: status } });
  }

  let nightWork = null;
  if (status === 'NIGHT_WORK' && effort) {
    const workDate = todayDateOnly();
    const startTime = effort.startTime ? combineDateTime(workDate, effort.startTime) : new Date();
    const endTime = effort.endTime ? resolveEndTime(startTime, combineDateTime(workDate, effort.endTime)) : null;
    nightWork = await recordNightWork(userId, startTime, endTime, composeEffortDescription(effort));
  }

  let businessTripLog = null;
  if (status === 'BUSINESS_TRIP' && businessTrip) {
    businessTripLog = await prisma.businessTripLog.create({
      data: {
        userId,
        destination: businessTrip.destination,
        purpose: businessTrip.purpose,
        startAt: new Date(businessTrip.startAt),
        endAt: businessTrip.endAt ? new Date(businessTrip.endAt) : null,
      },
    });
  }

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'status_change_log', targetId: log.id, afterValue: { log, effortLog, nightWork, businessTripLog } });
  return res.json({ success: true, data: { statusLog: log, effortLog, nightWork, businessTripLog, locationMismatchException } });
});

// 9개 상태 아이콘은 확인창 없이 눌리는 즉시 등록된다(2026-08 설계, "우선 등록 후 세부내용은
// 나중에"). 그래서 화면을 잘못 터치했을 때 흔적 없이 취소할 수 있는 안전장치가 필요하다
// (2026-09-04, 직원들의 오탭 신고에 따른 개선). 아무 로그나 지울 수 있게 하면 근태기록이
// 조작될 위험이 있으므로 세 가지를 반드시 만족해야만 되돌릴 수 있다:
// (1) 본인 소유의 로그인가, (2) 그 뒤로 다른 상태변경이 없는(=지금도 "현재 상태"인) 가장
// 최근 로그인가, (3) 등록한 지 10분이 지나지 않았는가.
const UNDO_WINDOW_MS = 10 * 60 * 1000;

const undoStatusSchema = z.object({
  statusLogId: z.string().min(1),
  effortLogId: z.string().optional(),
  nightWorkId: z.string().optional(),
  businessTripLogId: z.string().optional(),
});

/** 방금 등록한 상태(오탭 포함)를 취소한다 — /status POST 응답으로 받은 id들을 그대로 되돌려보낸다. */
attendanceRouter.post('/status/undo', async (req, res) => {
  const parsed = undoStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '요청 형식을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const { statusLogId, effortLogId, nightWorkId, businessTripLogId } = parsed.data;

  const log = await prisma.statusChangeLog.findUnique({ where: { id: statusLogId } });
  if (!log || log.userId !== userId) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '되돌릴 상태 기록을 찾을 수 없습니다.' } });
  }

  const newerExists = await prisma.statusChangeLog.findFirst({ where: { userId, changedAt: { gt: log.changedAt } } });
  if (newerExists) {
    return res.status(400).json({ success: false, error: { code: 'UNDO_STALE', message: '이미 다른 상태로 변경되어 되돌릴 수 없습니다.' } });
  }
  if (Date.now() - log.changedAt.getTime() > UNDO_WINDOW_MS) {
    return res.status(400).json({ success: false, error: { code: 'UNDO_EXPIRED', message: '등록 후 10분이 지나 되돌릴 수 없습니다.' } });
  }

  // 오늘의 첫 상태 등록이었다면 이 로그가 ensureClockIn으로 출근시각을 자동으로 찍었을 수 있다.
  // 그 사이 "출근" 버튼 등 다른 경로로 출근시각이 찍혔을 가능성도 있으니, 이 로그 시각과
  // 거의 동시(10초 이내)일 때만 안전하게 확신하고 같이 되돌린다.
  const workDate = todayDateOnly();
  const { start: dayStart } = realDayWindow(workDate);
  const olderTodayLog = await prisma.statusChangeLog.findFirst({ where: { userId, changedAt: { gte: dayStart, lt: log.changedAt } } });
  const wasFirstToday = !olderTodayLog;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (effortLogId) {
      const effort = await tx.effortLog.findUnique({ where: { id: effortLogId } });
      if (effort && effort.userId === userId) await tx.effortLog.delete({ where: { id: effortLogId } });
    }
    if (businessTripLogId) {
      const trip = await tx.businessTripLog.findUnique({ where: { id: businessTripLogId } });
      if (trip && trip.userId === userId) await tx.businessTripLog.delete({ where: { id: businessTripLogId } });
    }
    if (nightWorkId) {
      const session = await tx.nightWorkSession.findUnique({ where: { id: nightWorkId } });
      // 이 세션이 "이번 탭에서 새로 만들어진 것"이 확실할 때만 지운다 — 직전부터 진행중이던
      // 세션을 이번 호출이 그냥 이어받아 조회만 한 경우까지 지우면, 실제로 진행중인 야간작업
      // 기록이 사라져버린다(recordNightWork()는 IN_PROGRESS 세션이 있으면 새로 만들지 않고 재사용함).
      if (
        session
        && session.userId === userId
        && session.status === 'IN_PROGRESS'
        && Math.abs(session.startedAt.getTime() - log.changedAt.getTime()) < 10_000
      ) {
        await tx.nightWorkSession.delete({ where: { id: nightWorkId } });
      }
    }
    await tx.statusChangeLog.delete({ where: { id: statusLogId } });

    if (wasFirstToday) {
      const record = await tx.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } });
      if (record?.clockInAt && !record.clockOutAt && Math.abs(record.clockInAt.getTime() - log.changedAt.getTime()) < 10_000) {
        await tx.attendanceRecord.update({ where: { id: record.id }, data: { clockInAt: null } });
      }
    }
  });

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'status_change_log', targetId: statusLogId, afterValue: { undone: true } });
  return res.json({ success: true, data: { undone: true } });
});

// 마지막 근무위치(본사/고객사)를 30분 이상 벗어난 게 프론트에서 감지되면 이 세 엔드포인트를 쓴다.
// "시스템이 임의로 근태를 확정하지 않는다" 원칙을 지키기 위해, 자동감지는 항상 지난 근무일 정정
// 신청과 같은 승인 큐에 "제안"만 만들어두고, 실제 반영은 (1) 본인이 그 자리에서 확인하거나
// (2) 본인이 확인하지 않으면 담당자가 승인함에서 검토해야만 이뤄진다.

const departureSuggestSchema = z.object({
  estimatedClockOutAt: z.string().min(1),
});

/** 위치이탈이 30분 이상 이어졌을 때, 대기중인 퇴근시각 "제안"을 만든다(중복 호출은 기존 것을 그대로 반환). */
attendanceRouter.post('/departure-suggest', async (req, res) => {
  const parsed = departureSuggestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '요청 형식을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const estimatedClockOutAt = new Date(parsed.data.estimatedClockOutAt);
  if (Number.isNaN(estimatedClockOutAt.getTime())) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '추정 퇴근시각 형식이 올바르지 않습니다.' } });
  }

  const workDate = todayDateOnly();
  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } });
  if (!record || !record.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CLOCKED_IN', message: '출근 기록이 없습니다.' } });
  }
  if (record.clockOutAt) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_CLOCKED_OUT', message: '이미 퇴근 처리되었습니다.' } });
  }
  if (estimatedClockOutAt <= record.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'OUT_OF_RANGE', message: '추정 퇴근시각이 출근시각보다 앞섭니다.' } });
  }

  // 이미 오늘 만들어둔 대기중 자동감지 제안이 있으면 새로 만들지 않고 그대로 재사용한다.
  const existing = await prisma.attendanceCorrectionRequest.findFirst({
    where: { attendanceRecordId: record.id, status: 'PENDING', reason: { startsWith: AUTO_DEPARTURE_REASON_PREFIX } },
  });
  if (existing) {
    return res.json({ success: true, data: { correctionRequestId: existing.id, proposedClockOutAt: existing.proposedClockOutAt } });
  }

  const hhmm = estimatedClockOutAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
  const reason = `${AUTO_DEPARTURE_REASON_PREFIX} 마지막 근무위치에서 30분 이상 벗어난 것으로 감지되어 ${hhmm} 퇴근으로 제안되었습니다. 본인이 확인하면 바로 확정되고, 확인하지 않으면 담당자가 승인/반려할 수 있습니다.`;

  const correction = await prisma.attendanceCorrectionRequest.create({
    data: { userId, attendanceRecordId: record.id, proposedClockOutAt: estimatedClockOutAt, reason },
  });
  await prisma.approvalRequest.create({
    data: { type: 'ATTENDANCE_CORRECTION', referenceId: correction.id, requesterId: userId, attendanceCorrectionRequestId: correction.id },
  });

  await recordAuditLog({
    actorUserId: userId,
    actionType: 'STATUS_CHANGE',
    targetType: 'attendance_correction_request',
    targetId: correction.id,
    afterValue: { autoDetected: true, proposedClockOutAt: estimatedClockOutAt },
  });

  return res.json({ success: true, data: { correctionRequestId: correction.id, proposedClockOutAt: correction.proposedClockOutAt } });
});

const departureRequestIdSchema = z.object({ correctionRequestId: z.string().min(1) });
const departureConfirmSchema = z.object({
  correctionRequestId: z.string().min(1),
  // 확정하면 최소근무시간(정책값) 미만이 되는 경우 본인이 입력하는 조기퇴근 사유(하드블록 대신 사용) — /clock-out과 동일한 패턴.
  earlyLeaveReason: z.string().optional(),
});

/** 자동감지 제안을 본인이 그 자리에서 확인하고 즉시 확정한다(관리자 승인 없이도 가능 — 본인 확인이므로). */
attendanceRouter.post('/departure-suggest/confirm', async (req, res) => {
  const parsed = departureConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '요청 형식을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const earlyLeaveReason = parsed.data.earlyLeaveReason?.trim() ? parsed.data.earlyLeaveReason.trim().slice(0, 300) : undefined;
  const correction = await prisma.attendanceCorrectionRequest.findUnique({
    where: { id: parsed.data.correctionRequestId },
    include: { attendanceRecord: { select: { clockInAt: true } } },
  });
  if (!correction || correction.userId !== userId || !correction.reason.startsWith(AUTO_DEPARTURE_REASON_PREFIX)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.' } });
  }
  if (correction.status !== 'PENDING') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: '이미 처리된 요청입니다.' } });
  }

  // 2026-09-08: 위치이탈 자동감지로 확정되는 퇴근도 수동 "퇴근" 버튼과 동일하게 최소근무시간
  // (정책값, 기본 8시간) 규칙을 적용한다 — 김진호 사례(출근 1분/2시간 뒤 자동감지 시각으로
  // 사유 확인 없이 그대로 확정됨)로 발견된 사고를 막기 위함.
  // 2026-09-16: proposedClockOutAt이 nullable로 바뀐 뒤(CANCEL_CLOCK_OUT 타입 추가) 서버 빌드에서
  // TS2345로 걸림 — 위치이탈 자동감지 제안은 항상 proposedClockOutAt을 채워서 만들어지지만
  // (위 '/departure-suggest' 참고), 타입상으로는 null일 수 있으므로 null 가드를 추가한다
  // (approval.routes.ts의 동일 패턴과 맞춤).
  if (correction.attendanceRecord.clockInAt && correction.proposedClockOutAt) {
    const { ok, remainMinutes } = await checkMinWorkedMinutes(correction.attendanceRecord.clockInAt, correction.proposedClockOutAt);
    if (!ok && !earlyLeaveReason) {
      const remainH = Math.floor(remainMinutes / 60);
      const remainM = remainMinutes % 60;
      return res.status(400).json({
        success: false,
        error: {
          code: 'EARLY_LEAVE_REASON_REQUIRED',
          message: `아직 최소 근무시간을 채우지 않았습니다(${remainH}시간 ${remainM}분 부족). 조기퇴근 사유를 입력하시면 바로 확정됩니다.`,
        },
      });
    }
  }

  const applied = await applyAttendanceCorrection(correction.id, earlyLeaveReason);
  if (!applied) {
    return res.status(400).json({ success: false, error: { code: 'APPLY_FAILED', message: '처리할 수 없습니다.' } });
  }

  const approvalRequest = await prisma.approvalRequest.findUnique({ where: { attendanceCorrectionRequestId: correction.id } });
  if (approvalRequest && approvalRequest.status === 'PENDING') {
    await prisma.approvalRequest.update({
      where: { id: approvalRequest.id },
      data: { status: 'APPROVED', approverId: userId, decidedAt: new Date(), comment: '본인이 위치 이탈을 확인하고 직접 확정함' },
    });
  }

  await recordAuditLog({
    actorUserId: userId,
    actionType: 'CORRECT',
    targetType: 'attendance_record',
    targetId: applied.updatedRecord.id,
    afterValue: { clockOutAt: applied.updatedRecord.clockOutAt, totalWorkedMinutes: applied.totalWorkedMinutes, selfConfirmed: true },
  });

  return res.json({ success: true, data: applied.updatedRecord });
});

/** "아직 근무중이에요" — 오탐이었다고 본인이 알려주면 대기중 제안을 취소(반려)한다. */
attendanceRouter.post('/departure-suggest/dismiss', async (req, res) => {
  const parsed = departureRequestIdSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '요청 형식을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const correction = await prisma.attendanceCorrectionRequest.findUnique({ where: { id: parsed.data.correctionRequestId } });
  if (!correction || correction.userId !== userId || !correction.reason.startsWith(AUTO_DEPARTURE_REASON_PREFIX)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.' } });
  }
  if (correction.status !== 'PENDING') {
    return res.json({ success: true, data: { alreadyResolved: true } });
  }
  await cancelPendingAutoDepartureSuggestion(correction.attendanceRecordId, userId, '본인이 오탐(아직 근무중)으로 확인함');
  return res.json({ success: true, data: { dismissed: true } });
});

/** 본인 오늘 근태 조회 (상태는 "오늘" 것만 — 며칠 지난 상태를 현재처럼 보여주지 않는다) */
attendanceRouter.get('/me', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  const { start: dayStartReal, end: dayEndReal } = realDayWindow(workDate);
  const record = await prisma.attendanceRecord.findUnique({
    where: { userId_workDate: { userId, workDate } },
    include: { breakSessions: true },
  });
  const latestStatus = await prisma.statusChangeLog.findFirst({
    where: { userId, changedAt: { gte: dayStartReal, lt: dayEndReal } },
    orderBy: { changedAt: 'desc' },
  });
  // 위치이탈 자동감지(프론트)가 "지금 근무중인 고객사"의 좌표를 찾는 데 쓴다 — 고객사작업/미팅의
  // 고객사명은 note 자유서술 안에만 있어서, 같은 시점에 남긴 공수기록에서 따로 가져와 알려준다.
  const latestEffort = (latestStatus && EFFORT_STATUSES.has(latestStatus.status))
    ? await prisma.effortLog.findFirst({ where: { userId, workDate }, orderBy: { startTime: 'desc' } })
    : null;
  // 2026-09-06: 프론트가 "정규 근무시간이 지났는데 아직 퇴근 전이면 퇴근 후 야간작업으로
  // 이어가시겠어요?" 배너를 관리자 정책값과 맞춰 띄울 수 있도록, 값을 그대로 내려준다
  // (하드코딩하면 관리자가 정책값을 바꿨을 때 프론트만 안 맞게 되는 문제가 있어서).
  const regularWorkEndHour = await getPolicyNumber('REGULAR_WORK_END_HOUR', 18);
  return res.json({
    success: true,
    data: { record, latestStatus, latestEffort: latestEffort ? { clientName: latestEffort.clientName } : null, regularWorkEndHour },
  });
});

/**
 * 2026-09-15: "진행중"으로 남겨둔 공수 기록(고객사미팅/작업/재택/주말작업) 또는 야간작업 세션을
 * 조회한다 — 상세폼을 다시 열 때 프론트가 이 값으로 기존 입력을 이어받아 채워넣는다(박준영/
 * 이보용 피드백: 완료시간을 나중에 넣으려고 폼을 닫았다 다시 열면 처음부터 새로 입력해야 하던
 * 문제 해결). 이어받을 게 없으면 data: null.
 */
attendanceRouter.get('/effort/in-progress', async (req, res) => {
  const userId = req.authUser!.userId;
  const status = String(req.query.status || '');

  if (status === 'NIGHT_WORK') {
    const session = await prisma.nightWorkSession.findFirst({ where: { userId, status: 'IN_PROGRESS' } });
    if (!session) return res.json({ success: true, data: null });
    return res.json({
      success: true,
      data: {
        sourceStatus: 'NIGHT_WORK',
        clientName: '',
        projectName: '',
        workType: '',
        startTime: session.startedAt,
        description: session.note ?? '',
      },
    });
  }

  if (!EFFORT_CONTINUATION_STATUSES.has(status)) {
    return res.json({ success: true, data: null });
  }
  const open = await findOpenEffort(userId, status);
  if (!open) return res.json({ success: true, data: null });
  return res.json({
    success: true,
    data: {
      sourceStatus: open.sourceStatus,
      clientName: open.clientName,
      projectName: open.projectName,
      workType: open.workType,
      startTime: open.startTime,
      description: open.description ?? '',
    },
  });
});

/**
 * 본인의 이번 주(월~일) 누적 근무시간 — 주52시간제를 본인이 스스로 챙길 수 있게 보여준다.
/**
 * 본사 좌표 조회 — "고객사 미팅/작업 후 본사로 복귀하면 자동으로 알려주기" 기능용.
 * 직원이면 누구나 조회 가능(관리자 전용 라우터의 /clients/hq-location과 같은 값을 읽기 전용으로 제공).
 */
attendanceRouter.get('/hq-location', async (_req, res) => {
  const lat = await getPolicyString('HQ_LATITUDE', '');
  const lng = await getPolicyString('HQ_LONGITUDE', '');
  return res.json({
    success: true,
    data: { latitude: lat ? Number(lat) : null, longitude: lng ? Number(lng) : null },
  });
});

/**
 * 좌표가 등록된 고객사 목록(이름/위도/경도만) — "이동중" 상태에서 고객사 도착을 감지해
 * "고객사작업/미팅으로 등록하시겠어요?" 알림을 띄우는 기능용. 직원이면 누구나 조회 가능.
 */
attendanceRouter.get('/clients-with-location', async (_req, res) => {
  const clients = await prisma.client.findMany({
    where: { latitude: { not: null }, longitude: { not: null }, name: { not: { startsWith: 'SAMPLE_' } } },
    select: { name: true, latitude: true, longitude: true },
  });
  return res.json({ success: true, data: clients });
});

/**
 * 등록된 전체 고객사 목록(id/이름만, 좌표 유무 무관) — 고객사작업/미팅 등록 시 검색·선택용
 * 콤보박스 데이터 소스. clients.routes.ts의 관리자 전용 목록과 달리 직원이면 누구나 조회 가능
 * (2026-09-02: 클릭 한 번으로 즉시등록되던 고객사작업/미팅을 "목록에서 고르기"로 바꾸며 추가).
 */
attendanceRouter.get('/clients', async (_req, res) => {
  const clients = await prisma.client.findMany({
    where: { name: { not: { startsWith: 'SAMPLE_' } } },
    select: { id: true, name: true, address: true },
    orderBy: { name: 'asc' },
  });
  return res.json({ success: true, data: clients });
});

const createClientSchema = z.object({ name: z.string().min(1) });

/**
 * 목록에 없는 새 고객사를 직원이 그 자리에서 등록한다(관리자 승인 대기 없이 즉시 사용 가능해야
 * "귀찮아서 안 적는다"는 원래 문제가 재발하지 않는다). 좌표는 비워두고, 나중에 관리자가
 * clients.routes.ts에서 좌표를 채우면 위치대조 기능도 자동으로 적용된다. 이름이 이미 있으면
 * (대소문자 무관) 새로 만들지 않고 기존 것을 그대로 반환한다 — 같은 고객사가 오타 없이도
 * 중복 등록되는 것을 막기 위함.
 */
attendanceRouter.post('/clients', async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '고객사명을 입력하세요.' } });
  }
  const name = parsed.data.name.trim();
  const existing = await prisma.client.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (existing) {
    return res.json({ success: true, data: { id: existing.id, name: existing.name } });
  }
  // address는 DB상 필수 컬럼이지만, 직원이 현장에서 급하게 등록하는 상황이라 주소까지 입력받지
  // 않는다 — 빈 값으로 만들어두고, 나중에 관리자가 admin/clients.tsx에서 주소·좌표를 채워넣으면
  // 위치대조 기능도 그때부터 적용된다.
  const created = await prisma.client.create({ data: { name, address: '' } });
  return res.json({ success: true, data: { id: created.id, name: created.name } });
});

/**
 * (관리자 리포트와 달리 본인 것만, 아무 권한이나 조회 가능)
 */
attendanceRouter.get('/me/weekly', async (req, res) => {
  const userId = req.authUser!.userId;
  const today = todayDateOnly();
  const jsDay = today.getUTCDay(); // 0=일요일
  const diffToMonday = jsDay === 0 ? 6 : jsDay - 1;
  const monday = new Date(today.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
  const nextMonday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);

  const records = await prisma.attendanceRecord.findMany({
    where: { userId, workDate: { gte: monday, lt: nextMonday } },
  });
  const totalMinutes = records.reduce((sum, r) => sum + (r.totalWorkedMinutes ?? 0), 0);
  const days = records.filter((r) => r.totalWorkedMinutes != null).length;

  return res.json({
    success: true,
    data: {
      from: monday.toISOString().slice(0, 10),
      to: new Date(nextMonday.getTime() - 1).toISOString().slice(0, 10),
      totalMinutes,
      days,
    },
  });
});

/** 본인 이력 조회 */
attendanceRouter.get('/me/history', async (req, res) => {
  const userId = req.authUser!.userId;
  const [records, statusLogs] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { userId }, orderBy: { workDate: 'desc' }, take: 30 }),
    prisma.statusChangeLog.findMany({ where: { userId }, orderBy: { changedAt: 'desc' }, take: 50 }),
  ]);
  return res.json({ success: true, data: { records, statusLogs } });
});

/** 휴게 시작 */
attendanceRouter.post('/break/start', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } });
  if (!record || !record.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CLOCKED_IN', message: '출근 후에만 휴게를 시작할 수 있습니다.' } });
  }
  const breakSession = await prisma.breakSession.create({ data: { attendanceRecordId: record.id, startAt: new Date() } });
  return res.json({ success: true, data: breakSession });
});

/** 휴게 종료 */
attendanceRouter.post('/break/end', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  const record = await prisma.attendanceRecord.findUnique({
    where: { userId_workDate: { userId, workDate } },
    include: { breakSessions: { where: { endAt: null }, orderBy: { startAt: 'desc' }, take: 1 } },
  });
  const openBreak = record?.breakSessions[0];
  if (!openBreak) {
    return res.status(400).json({ success: false, error: { code: 'NO_OPEN_BREAK', message: '진행중인 휴게가 없습니다.' } });
  }
  const updated = await prisma.breakSession.update({ where: { id: openBreak.id }, data: { endAt: new Date() } });
  return res.json({ success: true, data: updated });
});
