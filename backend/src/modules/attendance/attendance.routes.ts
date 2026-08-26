import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly, ensureClockIn, combineDateTime, resolveEndTime } from '../../common/attendance-helpers';
import { recordNightWork } from '../../common/night-work-helpers';
import { checkLocationMatch } from '../../common/location';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

// 이 상태로 바뀌면 "실제 업무 시작"으로 보고 출근시각을 자동 인식한다(주52시간제 대응).
const WORK_START_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK']);
// 이 상태는 프로젝트별 공수(工數) 기록 대상이다.
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK']);

/** 출근 처리(수동) — 위 자동인식 대상이 아닌 경우를 위한 수동 버튼 */
attendanceRouter.post('/clock-in', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();

  const existing = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } });
  if (existing?.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_CLOCKED_IN', message: '이미 출근 처리되었습니다.' } });
  }

  const record = existing
    ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt: new Date() } })
    : await prisma.attendanceRecord.create({ data: { userId, workDate, clockInAt: new Date() } });

  // "출근"만 누르고 9개 상태 아이콘을 따로 안 고르면 계속 "상태 미확인"으로 남던 문제를 막기 위해,
  // 오늘 아직 상태를 하나도 안 골랐다면 일단 "본사근무"로 잠정 설정한다(직원이 실제 상태를 고르면 그게 우선).
  const dayEnd = new Date(workDate.getTime() + 24 * 60 * 60 * 1000);
  const todayStatus = await prisma.statusChangeLog.findFirst({ where: { userId, changedAt: { gte: workDate, lt: dayEnd } } });
  if (!todayStatus) {
    await prisma.statusChangeLog.create({
      data: { userId, status: 'HQ_WORKING', source: 'WEB', note: '출근 버튼 클릭 시 잠정 설정(실제 상태로 바꾸면 그 값이 우선함)' },
    });
  }

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'attendance_record', targetId: record.id, afterValue: { clockInAt: record.clockInAt } });

  return res.json({ success: true, data: record });
});

/** 퇴근 처리 — 그날의 "실질 근무"를 확정한다(주52시간 집계의 기준이 되는 실근무시간 계산) */
attendanceRouter.post('/clock-out', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();

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
    data: { clockOutAt, totalWorkedMinutes },
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

const statusSchema = z.object({
  status: z.enum([
    'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'MEETING', 'MOVING', 'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'CLIENT_MEETING', 'CLIENT_WORK',
  ]),
  note: z.string().optional(),
  effort: effortSchema.optional(),
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
  const { status, note, effort, location } = parsed.data;

  // 고객사미팅/고객사작업/야간작업은 작업시작·작업완료 시간이 필수다(진행중 상태로 남기지 않도록).
  const REQUIRE_TIME_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK']);
  if (REQUIRE_TIME_STATUSES.has(status) && (!effort?.startTime || !effort?.endTime)) {
    return res.status(400).json({ success: false, error: { code: 'TIME_REQUIRED', message: '작업시작·작업완료 시간을 모두 입력해야 합니다.' } });
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

  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'status_change_log', targetId: log.id, afterValue: { log, effortLog, nightWork } });
  return res.json({ success: true, data: { statusLog: log, effortLog, nightWork } });
});

/** 본인 오늘 근태 조회 (상태는 "오늘" 것만 — 며칠 지난 상태를 현재처럼 보여주지 않는다) */
attendanceRouter.get('/me', async (req, res) => {
  const userId = req.authUser!.userId;
  const workDate = todayDateOnly();
  const dayEnd = new Date(workDate.getTime() + 24 * 60 * 60 * 1000);
  const record = await prisma.attendanceRecord.findUnique({
    where: { userId_workDate: { userId, workDate } },
    include: { breakSessions: true },
  });
  const latestStatus = await prisma.statusChangeLog.findFirst({
    where: { userId, changedAt: { gte: workDate, lt: dayEnd } },
    orderBy: { changedAt: 'desc' },
  });
  return res.json({ success: true, data: { record, latestStatus } });
});

/**
 * 본인의 이번 주(월~일) 누적 근무시간 — 주52시간제를 본인이 스스로 챙길 수 있게 보여준다.
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
