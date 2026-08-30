import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly, ensureClockIn, combineDateTime, resolveEndTime, realDayWindow } from '../../common/attendance-helpers';
import { recordNightWork } from '../../common/night-work-helpers';
import { checkLocationMatch } from '../../common/location';
import { getPolicyNumber, getPolicyString } from '../../common/policy-engine/policy-engine';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

// 이 상태로 바뀌면 "실제 업무 시작"으로 보고 출근시각을 자동 인식한다(주52시간제 대응).
// REMOTE(재택)는 대부분 고객사에 원격 접속해서 작업하는 형태라, 접속 시작~종료를 다른 근무
// 유형과 동일하게(고객사작업과 같은 방식으로) 추적하기 위해 포함시켰다.
const WORK_START_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'BUSINESS_TRIP', 'REMOTE']);
// 이 상태는 프로젝트별 공수(工數) 기록 대상이다. REMOTE도 고객사작업과 동일하게 추적한다.
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE']);

/** 출근 처리(수동) — 위 자동인식 대상이 아닌 경우를 위한 수동 버튼 */
attendanceRouter.post('/clock-in', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  // 좌표는 저장하지 않고, 본사와의 거리 비교에만 즉시 사용하고 폐기한다.
  const location = req.body?.location as { lat: number; lng: number } | undefined;

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

  // 직출(본사 미경유): 위치정보가 있고 본사 좌표가 등록되어 있는데 본사와 멀리 떨어져 있으면,
  // "출근" 버튼으로 본사근무 처리해버리지 않고 고객사미팅/고객사작업으로 유도한다.
  if (location) {
    const hqLat = await getPolicyString('HQ_LATITUDE', '');
    const hqLng = await getPolicyString('HQ_LONGITUDE', '');
    if (hqLat && hqLng) {
      const match = checkLocationMatch(location, { latitude: Number(hqLat), longitude: Number(hqLng) });
      if (match && !match.locationMatch) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'AWAY_FROM_HQ',
            message: `현재 위치가 본사에서 약 ${match.locationDistanceMeters}m 떨어져 있어요. 본사로 출근하는 게 아니라면, "출근" 버튼 대신 고객사 도착 후 "고객사미팅" 또는 "고객사작업"을 눌러 진행해주세요 — 그 시점부터 자동으로 출근 처리됩니다.`,
          },
        });
      }
    }
  }

  const record = existing
    ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt: new Date() } })
    : await prisma.attendanceRecord.create({ data: { userId, workDate, clockInAt: new Date() } });

  // "출근"만 누르고 9개 상태 아이콘을 따로 안 고르면 계속 "상태 미확인"으로 남던 문제를 막기 위해,
  // 오늘 아직 상태를 하나도 안 골랐다면 일단 "본사근무"로 잠정 설정한다(직원이 실제 상태를 고르면 그게 우선).
  const { start: dayStartReal, end: dayEndReal } = realDayWindow(workDate);
  const todayStatus = await prisma.statusChangeLog.findFirst({ where: { userId, changedAt: { gte: dayStartReal, lt: dayEndReal } } });
  if (!todayStatus) {
    await prisma.statusChangeLog.create({
      data: { userId, status: 'HQ_WORKING', source: 'WEB', note: '출근 버튼 클릭 시 잠정 설정(실제 상태로 바꾸면 그 값이 우선함)' },
    });
  }

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'attendance_record', targetId: record.id, afterValue: { clockInAt: record.clockInAt } });

  return res.json({ success: true, data: record });
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
  const isNightWorkDay = latestStatusToday?.status === 'NIGHT_WORK';
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
  const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes);

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
  projectName: z.string().optional(),
  workType: z.string().optional(),
  startTime: z.string().optional(), // "HH:MM" (KST)
  endTime: z.string().optional(), // "HH:MM" (KST), 없으면 진행중
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
    'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'MEETING', 'MOVING', 'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'CLIENT_MEETING', 'CLIENT_WORK', 'BUSINESS_TRIP',
  ]),
  note: z.string().optional(),
  effort: effortSchema.optional(),
  businessTrip: businessTripSchema.optional(),
  // 고객사미팅/고객사작업 등록 시 그 순간의 좌표(대조 후 즉시 폐기, 저장 안 함)
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  // 위치를 못 가져온 이유(권한거부/타임아웃/미동의 등) — location이 없을 때만 의미 있음.
  // clock-out과 동일한 값 목록(LOCATION_CAPTURE_STATUSES)을 그대로 사용한다.
  locationStatus: z.string().optional(),
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
const REQUIRE_SITE_TYPE_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK']);
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
  const { status, note, effort, location, businessTrip, siteType, locationStatus: rawLocationStatus } = parsed.data;
  const locationCaptureStatus = location
    ? 'OK'
    : rawLocationStatus && LOCATION_CAPTURE_STATUSES.has(rawLocationStatus)
      ? (rawLocationStatus as 'NO_CONSENT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | 'GEOCODE_FAILED')
      : undefined;

  // 출장은 목적지/기간/목적이 필수다(계획된 정보라 즉시 확정해서 남긴다).
  if (status === 'BUSINESS_TRIP' && !businessTrip) {
    return res.status(400).json({ success: false, error: { code: 'BUSINESS_TRIP_REQUIRED', message: '목적지·출발일시·목적을 모두 입력해야 합니다.' } });
  }

  // 고객사미팅/고객사작업/야간작업/재택은 작업시작 시간만 있으면 등록 가능하다(막 시작한 시점엔 완료시간을
  // 알 수 없는 게 당연하므로). 완료시간은 나중에 다시 등록해서 채우면 된다("진행중" 허용).
  const REQUIRE_TIME_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'REMOTE']);
  if (REQUIRE_TIME_STATUSES.has(status) && !effort?.startTime) {
    return res.status(400).json({ success: false, error: { code: 'TIME_REQUIRED', message: '작업시작 시간을 입력해야 합니다.' } });
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

  // 본사근무 등록: 위치정보가 있고 본사 좌표가 등록되어 있는데 본사와 멀리 떨어져 있으면,
  // "출근" 버튼과 동일하게 본사근무 등록 자체를 막고 고객사미팅/고객사작업으로 유도한다.
  // 고객사작업/미팅과 동일한 원칙 — 위치는 잡혔는데 실제로 멀면 항상 차단하고, 위치 확보
  // 자체가 실패(권한거부/타임아웃/미동의 등)했으면 오늘 첫 실패는 봐주되 그 다음부터는 실제
  // 위치 일치를 요구한다. 이게 없으면 위치를 안 주는 것만으로 검증이 통째로 무력화된다.
  let hqLocationResult: { locationMatch: boolean; locationDistanceMeters: number } | null = null;
  if (status === 'HQ_WORKING') {
    const hqLat = await getPolicyString('HQ_LATITUDE', '');
    const hqLng = await getPolicyString('HQ_LONGITUDE', '');
    if (hqLat && hqLng) {
      hqLocationResult = checkLocationMatch(location, { latitude: Number(hqLat), longitude: Number(hqLng) });
      if (hqLocationResult && !hqLocationResult.locationMatch) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'AWAY_FROM_HQ',
            message: `현재 위치가 본사에서 약 ${hqLocationResult.locationDistanceMeters}m 떨어져 있어요. 본사근무 대신 "고객사미팅" 또는 "고객사작업"으로 등록해주세요.`,
          },
        });
      }
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

  // 위치대조: 입력한 고객사명과 등록된 고객사를 이름으로 매칭해서 좌표를 비교한다.
  // 매칭되는 고객사가 없거나 좌표 미등록이면 대조할 대상이 없으니 그냥 null(확인 안 함)로 둔다.
  let locationResult: { locationMatch: boolean; locationDistanceMeters: number } | null = null;
  let matchedClientForLocation: { latitude: number | null; longitude: number | null } | null = null;
  if (LOCATION_CHECK_STATUSES.has(status) && effort?.clientName) {
    matchedClientForLocation = await prisma.client.findFirst({
      where: { name: { contains: effort.clientName.trim(), mode: 'insensitive' } },
    });
    locationResult = checkLocationMatch(location, matchedClientForLocation);
  }

  // 등록된 고객사 좌표가 있는 경우에만 강제한다(현장 사칭 방지).
  // - 위치는 잡혔는데 실제 거리가 멀면: 몇 번을 시도해도 항상 차단.
  // - 위치 확보 자체가 실패(권한거부/타임아웃 등)했으면: 오늘 첫 실패는 봐주고 통과시키되,
  //   이미 한 번 봐준 뒤부터는 실제로 위치가 일치해야만 통과시킨다.
  if (LOCATION_CHECK_STATUSES.has(status) && matchedClientForLocation?.latitude != null && matchedClientForLocation?.longitude != null) {
    if (locationResult && !locationResult.locationMatch) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'LOCATION_MISMATCH',
          message: `현재 위치가 등록된 고객사에서 약 ${locationResult.locationDistanceMeters}m 떨어져 있어요. 고객사 현장에서 다시 시도해주세요.`,
        },
      });
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

  const log = await prisma.statusChangeLog.create({
    data: {
      userId,
      status,
      note,
      source: 'WEB',
      locationMatch: (locationResult ?? hqLocationResult)?.locationMatch ?? null,
      locationDistanceMeters: (locationResult ?? hqLocationResult)?.locationDistanceMeters ?? null,
      siteType: siteType ?? null,
      locationCaptureStatus: (LOCATION_CHECK_STATUSES.has(status) || status === 'HQ_WORKING') ? (locationCaptureStatus ?? null) : null,
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
    const minutes = endTime ? Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 60000)) : null;
    effortLog = await prisma.effortLog.create({
      data: {
        userId,
        workDate,
        clientName: effort.clientName || '',
        projectName: effort.projectName || '',
        workType: effort.workType || '기타',
        startTime,
        endTime,
        minutes,
        description: composeEffortDescription(effort),
      },
    });
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
  return res.json({ success: true, data: { statusLog: log, effortLog, nightWork, businessTripLog } });
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
  return res.json({ success: true, data: { record, latestStatus } });
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
