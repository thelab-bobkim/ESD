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
const WORK_START_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'BUSINESS_TRIP']);
// 이 상태는 프로젝트별 공수(工數) 기록 대상이다.
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK']);

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

  // 출근 찍자마자 실수로(또는 급하게) 바로 퇴근을 눌러버리는 사고를 막기 위해, 최소근무시간을
  // 채우기 전에는 퇴근을 막는다(정책값 — 관리자가 나중에 조정 가능, 기본 8시간).
  const minMinutes = (await getPolicyNumber('MIN_HOURS_BEFORE_CLOCKOUT', 8)) * 60;
  const elapsedMinutes = Math.round((Date.now() - existing.clockInAt.getTime()) / 60000);
  if (elapsedMinutes < minMinutes) {
    const remain = minMinutes - elapsedMinutes;
    const remainH = Math.floor(remain / 60);
    const remainM = remain % 60;
    return res.status(400).json({
      success: false,
      error: {
        code: 'MIN_WORK_TIME_NOT_MET',
        message: `아직 최소 근무시간을 채우지 않았습니다. ${remainH}시간 ${remainM}분 더 근무 후 퇴근해주세요.`,
      },
    });
  }

  const clockOutAt = new Date();
  const totalBreakMinutes = existing.breakSessions.reduce((sum, b) => {
    if (!b.endAt) return sum;
    return sum + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000);
  }, 0);
  const grossMinutes = Math.round((clockOutAt.getTime() - existing.clockInAt.getTime()) / 60000);
  const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes);

  const record = await prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      clockOutAt,
      totalWorkedMinutes,
      ...(clockOutLocation ? { clockOutLocation } : {}),
      ...(clockOutLocationStatus ? { clockOutLocationStatus } : {}),
    },
  });

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'attendance_record', targetId: record.id, afterValue: { clockOutAt, totalWorkedMinutes } });

  return res.json({ success: true, data: record });
});

const effortSchema = z.object({
  clientName: z.string().optional(),
  projectName: z.string().optional(),
  workType: z.string().optional(),
  startTime: z.string().optional(), // "HH:MM" (KST)
  endTime: z.string().optional(), // "HH:MM" (KST), 없으면 진행중
  description: z.string().optional(),
});

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
});

// 이 상태들만 GPS 위치대조 대상이다(고객사 위치와 비교할 대상이 있는 경우만).
const LOCATION_CHECK_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);

/** 현재 상태 변경. 업무 시작류 상태면 출근시각을 자동 인식하고, 고객사미팅/작업이면 공수기록도 남긴다. */
attendanceRouter.post('/status', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '상태값을 확인하세요.' } });
  }
  const userId = req.authUser!.userId;
  const { status, note, effort, location, businessTrip } = parsed.data;

  // 출장은 목적지/기간/목적이 필수다(계획된 정보라 즉시 확정해서 남긴다).
  if (status === 'BUSINESS_TRIP' && !businessTrip) {
    return res.status(400).json({ success: false, error: { code: 'BUSINESS_TRIP_REQUIRED', message: '목적지·출발일시·목적을 모두 입력해야 합니다.' } });
  }

  // 고객사미팅/고객사작업/야간작업은 작업시작 시간만 있으면 등록 가능하다(막 시작한 시점엔 완료시간을
  // 알 수 없는 게 당연하므로). 완료시간은 나중에 다시 등록해서 채우면 된다("진행중" 허용).
  const REQUIRE_TIME_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK']);
  if (REQUIRE_TIME_STATUSES.has(status) && !effort?.startTime) {
    return res.status(400).json({ success: false, error: { code: 'TIME_REQUIRED', message: '작업시작 시간을 입력해야 합니다.' } });
  }

  // 본사근무 등록: 위치정보가 있고 본사 좌표가 등록되어 있는데 본사와 멀리 떨어져 있으면,
  // "출근" 버튼과 동일하게 본사근무 등록 자체를 막고 고객사미팅/고객사작업으로 유도한다.
  if (status === 'HQ_WORKING' && location) {
    const hqLat = await getPolicyString('HQ_LATITUDE', '');
    const hqLng = await getPolicyString('HQ_LONGITUDE', '');
    if (hqLat && hqLng) {
      const hqMatch = checkLocationMatch(location, { latitude: Number(hqLat), longitude: Number(hqLng) });
      if (hqMatch && !hqMatch.locationMatch) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'AWAY_FROM_HQ',
            message: `현재 위치가 본사에서 약 ${hqMatch.locationDistanceMeters}m 떨어져 있어요. 본사근무 대신 "고객사미팅" 또는 "고객사작업"으로 등록해주세요.`,
          },
        });
      }
    }
  }

  // 위치대조: 입력한 고객사명과 등록된 고객사를 이름으로 매칭해서 좌표를 비교한다.
  // 매칭되는 고객사가 없거나 좌표 미등록/위치권한 없음이면 그냥 null(확인 안 함)로 둔다.
  let locationResult: { locationMatch: boolean; locationDistanceMeters: number } | null = null;
  if (LOCATION_CHECK_STATUSES.has(status) && effort?.clientName) {
    const matchedClient = await prisma.client.findFirst({
      where: { name: { contains: effort.clientName.trim(), mode: 'insensitive' } },
    });
    locationResult = checkLocationMatch(location, matchedClient);
  }

  const log = await prisma.statusChangeLog.create({
    data: {
      userId,
      status,
      note,
      source: 'WEB',
      locationMatch: locationResult?.locationMatch ?? null,
      locationDistanceMeters: locationResult?.locationDistanceMeters ?? null,
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
        description: effort.description,
      },
    });
  }

  let nightWork = null;
  if (status === 'NIGHT_WORK' && effort) {
    const workDate = todayDateOnly();
    const startTime = effort.startTime ? combineDateTime(workDate, effort.startTime) : new Date();
    const endTime = effort.endTime ? resolveEndTime(startTime, combineDateTime(workDate, effort.endTime)) : null;
    nightWork = await recordNightWork(userId, startTime, endTime, effort.description);
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
