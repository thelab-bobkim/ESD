import { createRouter } from '../../common/async-router';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { realDayWindow, PROVISIONAL_HQ_NOTE } from '../../common/attendance-helpers';
import { recordAuditLog } from '../../common/audit';
// 2026-09-30 보안수정: approval.routes.ts와 동일한 부서 스코핑 판단을 재사용한다(아래 /correct-status 참고).
import { getApprovableDepartmentIds } from '../approval/approval.routes';

// 본사근무/고객사작업/고객사미팅/재택은 "우선 등록, 세부내용은 나중에" 원칙상 등록 직후엔
// note가 비어있을 수 있다(attendance.routes.ts EFFORT_STATUSES와 동일하게 유지). 이 경우에도
// 실제로는 클라이언트명이 effort_logs에 남아있는 경우가 있어(예: GPS 도착팝업으로 고객사명은
// 정해졌지만 세부폼은 아직 제출 전), 상황판에서 "고객사 정보가 아예 없다"고 오해하지 않도록
// 그 값을 별도 필드(effortClientName)로 함께 내려준다(2026-09-04, 관리자 문의 대응).
// WEEKEND_WORK도 attendance.routes.ts에서 EffortLog를 생성하므로 여기에도 포함시킨다(2026-09-06).
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK']);

// 위치대조를 실제로 시도하는 상태 — 프론트 admin/dashboard.tsx의 동명 상수와 동일하게 유지.
// 2026-09-19: 야간작업/주말작업도 현장(ONSITE)+고객사 등록이면 attendance.routes.ts가 위치대조를
// 하도록 이미 바뀌었는데, 상황판(이 파일)이 여전히 옛 세 상태만 봐서 그 결과가 화면에 전혀 안
// 나타나는 문제가 있었다(관리자 문의 — 주말작업/야간작업 인원의 위치 배지가 안 보임). 여기 추가.
const LOCATION_CHECK_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK']);

// 2026-09-18: "불일치 건만 좌표 저장" 정책 — 원본 GPS 좌표는 상황판을 볼 수 있는 모든 역할
// (TEAM_LEAD/PILOT_MANAGER 포함)이 아니라, 더 좁은 관리자 역할에만 노출한다(사용자 승인 사항:
// "관리자 전용 노출"). 상황판 자체(위치 불일치 여부/거리)는 기존과 동일하게 전 역할에 내려간다.
const MISMATCH_COORD_VIEW_ROLES = new Set(['HR_ADMIN', 'SYSTEM_ADMIN']);

export const dashboardRouter = createRouter();
dashboardRouter.use(requireAuth, requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN', 'PILOT_MANAGER'));

/**
 * "오늘"의 날짜 경계를 계산한다. attendance.routes.ts의 todayDateOnly()와 동일하게, 자정이 아니라
 * 새벽 3시(KST)를 하루의 경계로 삼는다(야간작업자 고려). 특정 날짜를 직접 넘기면 그 값을 그대로 쓴다.
 */
function dateOnlyUTC(d?: Date): Date {
  if (d) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const now = new Date();
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  return new Date(Date.UTC(kstShifted.getUTCFullYear(), kstShifted.getUTCMonth(), kstShifted.getUTCDate()));
}

/** 정렬된 목록에서 userId별 첫 행(=가장 최근 행)만 남긴다. */
function firstByUser<T extends { userId: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) if (!m.has(r.userId)) m.set(r.userId, r);
  return m;
}

/**
 * 사용자별 "그 날짜"의 마지막 상태 변경 로그를 모아 상황판을 만든다.
 * forDate를 안 넘기면 오늘 기준(라이브 상황판), 과거 날짜를 넘기면 그날의 스냅샷(캘린더 조회용)이 된다.
 *
 * 2026-09-30 재작성(Medium, N+1 제거): 예전엔 직원 1명마다 최대 5~6번씩 쿼리를 날렸다
 * (상태로그·도착체크·근태·공수·위치성공로그·고객사진단). 표시대상 90~150명이면 요청 1번에
 * 400~750개 쿼리였고, 관리자 상황판은 15초마다 폴링하므로 접속한 관리자 수만큼 그대로 곱해졌다.
 * 이제 그날 하루치를 테이블당 한 번씩만 일괄 조회(총 5회 + 서로 다른 진단 고객사명 수만큼)한 뒤
 * 메모리에서 사용자별로 나눈다. 사용자별 판정 로직(무엇을 "그날의 상태"로 볼지, 위치 배지를
 * 어떻게 고를지 등)은 한 줄도 바꾸지 않았다 — 기존 구현과 결과가 같은지는
 * __tests__/status-board.test.ts가 무작위 데이터로 직접 비교한다.
 */
export async function buildStatusBoard(userIds?: string[], forDate: Date = dateOnlyUTC(), includeMismatchCoords = false) {
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
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);

  // ── 하루치 일괄 조회 (정렬은 기존 findFirst의 orderBy와 동일하게) ──────────────────
  const [dayLogs, dayCheckins, dayAttendance, dayEfforts] = await Promise.all([
    prisma.statusChangeLog.findMany({
      where: { userId: { in: ids }, changedAt: { gte: dayStart, lt: dayEnd } },
      orderBy: { changedAt: 'desc' },
    }),
    prisma.residentCheckin.findMany({
      where: { userId: { in: ids }, checkinAt: { gte: dayStart, lt: dayEnd } },
      orderBy: { checkinAt: 'desc' },
    }),
    prisma.attendanceRecord.findMany({
      where: { userId: { in: ids }, workDate: workDateLabel },
    }),
    prisma.effortLog.findMany({
      where: { userId: { in: ids }, workDate: workDateLabel },
      orderBy: { startTime: 'desc' },
    }),
  ]);

  const statusByUser = firstByUser(dayLogs);
  const checkinByUser = firstByUser(dayCheckins);
  const attendanceByUser = new Map(dayAttendance.map((a) => [a.userId, a] as const));
  const effortByUser = firstByUser(dayEfforts);
  // 기존: status in LOCATION_CHECK_STATUSES && locationMatch=true 중 가장 최근 1건 — 같은 하루치
  // 로그(dayLogs, 이미 최신순)에서 그대로 골라낸다(별도 쿼리 불필요).
  const bestLocationByUser = firstByUser(
    dayLogs.filter((l) => LOCATION_CHECK_STATUSES.has(l.status) && l.locationMatch === true)
  );

  // 고객사 위치 진단 — 기존과 "완전히 같은 쿼리"를 쓰되, 같은 고객사명은 한 번만 조회한다
  // (같은 고객사에 여러 명이 가 있는 경우가 흔해 대부분 몇 건으로 줄어든다).
  const diagnosisCache = new Map<string, Promise<{ latitude: number | null; longitude: number | null } | null>>();
  function findClientForDiagnosis(name: string) {
    let p = diagnosisCache.get(name);
    if (!p) {
      p = prisma.client.findFirst({ where: { name: { contains: name, mode: 'insensitive' } } });
      diagnosisCache.set(name, p);
    }
    return p;
  }

  const board = await Promise.all(
    users.map(async (u) => {
      const statusOnDay = statusByUser.get(u.id) ?? null;
      const checkinOnDay = checkinByUser.get(u.id) ?? null;
      // 퇴근했으면 상황판에서 "마지막 상태" 대신 "퇴근완료"로 보여줄 수 있게 별도로 알려준다.
      // 단, 야간작업자는 퇴근 후에도 계속 상태를 등록할 수 있으므로, 퇴근시각 이후 새로 등록된
      // 상태가 있으면(=야간작업 등) 그 상태를 그대로 보여주고 "퇴근완료"로 덮어쓰지 않는다.
      const attendanceOnDay = attendanceByUser.get(u.id) ?? null;
      const clockedOut = Boolean(attendanceOnDay?.clockOutAt)
        && (!statusOnDay || statusOnDay.changedAt <= attendanceOnDay!.clockOutAt!);
      // note가 비어있는데 상태가 공수 대상(EFFORT_STATUSES)이면, 세부폼 제출 전이라도 이미
      // 남아있을 수 있는 effort_logs의 고객사명을 대신 조회해서 보여준다(위 EFFORT_STATUSES 주석 참고).
      const needsEffortFallback = !statusOnDay?.note && statusOnDay?.status && EFFORT_STATUSES.has(statusOnDay.status);
      const fallbackEffort = needsEffortFallback ? (effortByUser.get(u.id) ?? null) : null;
      // 2026-09-09: 그날 같은 종류의 상태 등록 중 단 한 번이라도 위치 확인에 성공(locationMatch=true)한
      // 이력이 있으면, 그 이력을 기준으로 확인됨 처리한다(마지막 로그 1건만 보면 하루 종일 "위치 미확인"으로
      // 표시되던 문제).
      const statusIsLocationChecked = Boolean(statusOnDay?.status && LOCATION_CHECK_STATUSES.has(statusOnDay.status));
      const bestLocationLogToday = statusIsLocationChecked && statusOnDay?.locationMatch !== true
        ? (bestLocationByUser.get(u.id) ?? null)
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
      // 2026-09-16: 위치 판정에 이미 반영된 GPS 오차범위를 상황판에도 같이 보여준다.
      const effectiveLocationAccuracyMeters = bestLocationLogToday
        ? bestLocationLogToday.locationAccuracyMeters
        : (statusOnDay?.locationAccuracyMeters ?? checkinOnDay?.locationAccuracyMeters ?? null);
      // 2026-09-18: "불일치 건만 좌표 저장" 정책 — 관리자 역할 요청일 때만 채운다.
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

      // 2026-09-17: "위치 미확인"의 원인이 GPS가 아니라 고객사 미등록/좌표 없음인지 진단한다.
      const isClientLocationStatus = statusOnDay?.status === 'CLIENT_MEETING' || statusOnDay?.status === 'CLIENT_WORK';
      let clientLocationDiagnosis: 'NO_CLIENT_MATCH' | 'CLIENT_NO_COORDS' | null = null;
      let clientLocationDiagnosisName: string | null = null;
      if (isClientLocationStatus && effectiveLocationMatch !== true && statusOnDay?.siteType !== 'REMOTE') {
        const effortForDiagnosis = fallbackEffort ?? (effortByUser.get(u.id) ?? null);
        const diagnosisClientName = effortForDiagnosis?.clientName?.trim();
        if (diagnosisClientName) {
          const matchedClient = await findClientForDiagnosis(diagnosisClientName);
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
        // 위치대조 결과가 null인 이유(시도 안 함/캡처 실패/미동의)를 프론트가 구분하는 데 쓴다.
        locationCaptureStatus: effectiveLocationCaptureStatus,
        mismatchLatitude: effectiveMismatchLatitude,
        mismatchLongitude: effectiveMismatchLongitude,
        clientLocationDiagnosis,
        clientLocationDiagnosisName,
        // "원격" 등록은 위치대조 대상이 아니다(프론트가 이 값을 보고 제외).
        siteType: statusOnDay?.siteType ?? null,
        locationConsentGiven: u.locationConsentAt != null,
        privacyConsentGiven: u.privacyConsentAt != null,
        lastConfirmedAt: checkinOnDay?.lastConfirmedAt ?? null,
        clockedOut,
        clockOutAt: attendanceOnDay?.clockOutAt ?? null,
        // "출근" 버튼만 누르고 상태를 고른 적이 없어 잠정 HQ_WORKING으로 채워진 기록인지 여부.
        isProvisional: statusOnDay?.note === PROVISIONAL_HQ_NOTE,
      };
    })
  );
  return board;
}

/** 요청한 사용자가 원본 좌표(불일치 건 한정)까지 볼 수 있는 관리자 역할인지 판단한다. */
function canViewMismatchCoords(req: import('express').Request): boolean {
  const roles = req.authUser?.roles ?? [];
  return roles.some((r) => MISMATCH_COORD_VIEW_ROLES.has(r));
}

dashboardRouter.get('/company', async (req, res) => {
  const board = await buildStatusBoard(undefined, undefined, canViewMismatchCoords(req));
  const summary: Record<string, number> = {};
  for (const row of board) {
    const key = row.status ?? 'UNKNOWN';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return res.json({ success: true, data: { summary, employees: board } });
});

dashboardRouter.get('/department/:id', async (req, res) => {
  const users = await prisma.user.findMany({ where: { departmentId: req.params.id }, select: { id: true } });
  const board = await buildStatusBoard(users.map((u) => u.id), undefined, canViewMismatchCoords(req));
  return res.json({ success: true, data: board });
});

dashboardRouter.get('/client/:id', async (req, res) => {
  const users = await prisma.user.findMany({ where: { assignedClientId: req.params.id }, select: { id: true } });
  const board = await buildStatusBoard(users.map((u) => u.id), undefined, canViewMismatchCoords(req));
  return res.json({ success: true, data: board });
});

// 2026-09-23: "관리자 상태 정정" — 직원이 실수로 다른 상태(예: 본사출근)를 눌러 확정해버려서
// 본인이 더 이상 고칠 수 없는 경우(예: 윤혜선 사원 — 휴가인데 본사출근을 눌러버림), 관리자가
// 그 자리에서 사유를 남기고 오늘 상태를 바로 잡을 수 있게 한다.
// - StatusSource에는 "관리자 정정"에 해당하는 값이 따로 없다(WEB/MOBILE/SYSTEM뿐) — 새 값을
//   추가하려면 배포 시 수동으로 `ALTER TYPE`을 실행해야 하는 위험이 있어(위 WEEKEND_WORK 추가 시
//   주석 참고), 대신 note에 "[관리자 수정] 사유"를 남기고 AuditLog(actionType=CORRECT)에 정식으로
//   기록해 추적한다.
// - 기존 로그를 수정/삭제하지 않고 changedAt이 더 늦은 새 로그를 추가만 한다 — buildStatusBoard가
//   "그날 가장 최근 로그"를 현재 상태로 보여주는 로직을 그대로 타므로, 그 외에는 아무것도 바꿀 필요가 없다.
// - PILOT_MANAGER는 상황판을 볼 수는 있지만(위 라우터 레벨 requireRole) 이 쓰기 작업까지는 허용하지
//   않는다 — approval.routes.ts의 쓰기 엔드포인트 권한 규칙과 동일하게 맞춘다.
const correctStatusSchema = z.object({
  userId: z.string().min(1),
  newStatus: z.enum([
    'HQ_WORKING',
    'RESIDENT_ONSITE',
    'OFFSITE',
    'MEETING',
    'MOVING',
    'REMOTE',
    'NIGHT_WORK',
    'WEEKEND_WORK',
    'ALT_DAY_OFF',
    'ON_LEAVE',
    'CLIENT_MEETING',
    'CLIENT_WORK',
    'BUSINESS_TRIP',
  ]),
  reason: z.string().trim().min(2, '사유를 2자 이상 입력해주세요.').max(200),
});

dashboardRouter.post('/correct-status', requireRole('TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  const parsed = correctStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해주세요.' });
  }
  const { userId, newStatus, reason } = parsed.data;
  const actorUserId = req.authUser!.userId;

  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!targetUser) {
    return res.status(404).json({ success: false, message: '대상 직원을 찾을 수 없습니다.' });
  }

  // 2026-09-30 보안수정: approval.routes.ts(승인 처리)는 이미 2026-08-30에 "TEAM_LEAD는 본인
  // 소속/담당 부서까지만" 스코핑을 넣었는데, 이 관리자 상태정정 엔드포인트는 그 조치에서 빠져있어
  // 부서와 무관한 아무 TEAM_LEAD나 전사 아무 직원의 상태를 정정할 수 있었다(HR_ADMIN/SYSTEM_ADMIN은
  // 기존과 동일하게 전사 권한 유지 — getApprovableDepartmentIds가 이 경우 null을 반환).
  const departmentIds = await getApprovableDepartmentIds(req.authUser!);
  if (departmentIds && !departmentIds.includes(targetUser.departmentId ?? '')) {
    return res.status(403).json({ success: false, message: '다른 부서 직원의 상태는 정정할 권한이 없습니다.' });
  }

  // 상황판과 동일한 "하루" 경계 기준으로, 지금 화면에 보이는 오늘 상태를 정정 대상으로 삼는다.
  const { start: dayStart, end: dayEnd } = realDayWindow(dateOnlyUTC());
  const previousLog = await prisma.statusChangeLog.findFirst({
    where: { userId, changedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { changedAt: 'desc' },
  });

  const newLog = await prisma.statusChangeLog.create({
    data: {
      userId,
      status: newStatus,
      note: `[관리자 수정] ${reason}`,
      source: previousLog?.source ?? 'WEB',
    },
  });

  await recordAuditLog({
    actorUserId,
    actionType: 'CORRECT',
    targetType: 'status_change_log',
    targetId: newLog.id,
    beforeValue: previousLog
      ? { status: previousLog.status, note: previousLog.note, changedAt: previousLog.changedAt }
      : null,
    afterValue: { status: newStatus, reason, targetUserId: userId, targetUserName: targetUser.name },
    ipAddress: req.ip ?? null,
  });

  return res.json({ success: true, data: { id: newLog.id, status: newLog.status, changedAt: newLog.changedAt } });
});

const daySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** 캘린더에서 특정 날짜를 클릭했을 때, 그날의 상황판 스냅샷을 조회한다. */
dashboardRouter.get('/day', async (req, res) => {
  const parsed = daySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date(YYYY-MM-DD)가 필요합니다.' } });
  }
  // 2026-09-30 수정: 정규식만으로는 "9999-99-99" 같은 값이 통과해 Invalid Date가 되고, 그 값이
  // Prisma where로 넘어가 async 핸들러에서 예외(→ 프로세스 종료)로 이어질 수 있었다.
  const forDate = new Date(`${parsed.data.date}T00:00:00.000Z`);
  if (Number.isNaN(forDate.getTime())) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date(YYYY-MM-DD)가 올바르지 않습니다.' } });
  }
  const board = await buildStatusBoard(undefined, forDate, canViewMismatchCoords(req));
  const summary: Record<string, number> = {};
  for (const row of board) {
    const key = row.status ?? 'UNKNOWN';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return res.json({ success: true, data: { date: parsed.data.date, summary, employees: board } });
});

const monthSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * 캘린더 월별 요약 — 하루하루 셀에 표시할 간단한 숫자만 가볍게 집계한다.
 * (출근 인정: attendance_records.clock_in_at이 있는 날 / 근무확정: 퇴근까지 처리되어 실근무시간이 있는 날)
 */
dashboardRouter.get('/calendar', async (req, res) => {
  const parsed = monthSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'year, month가 필요합니다.' } });
  }
  const { year, month } = parsed.data;
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const records = await prisma.attendanceRecord.findMany({
    where: { workDate: { gte: from, lt: to } },
    select: { workDate: true, clockInAt: true, totalWorkedMinutes: true },
  });

  const byDate = new Map<string, { clockedIn: number; workedConfirmed: number }>();
  for (const r of records) {
    const key = r.workDate.toISOString().slice(0, 10);
    const cur = byDate.get(key) ?? { clockedIn: 0, workedConfirmed: 0 };
    if (r.clockInAt) cur.clockedIn += 1;
    if (r.totalWorkedMinutes != null) cur.workedConfirmed += 1;
    byDate.set(key, cur);
  }

  const days = Array.from(byDate.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return res.json({ success: true, data: { year, month, days } });
});

/**
 * 최근 활동 피드 — "지금 누가 뭘 눌렀는지"를 시간순으로 보여준다.
 * 예외/경고가 아니라 있는 그대로의 활동 중계라, 회사 전체의 움직임을 체감하기 좋다.
 */
dashboardRouter.get('/recent-activity', async (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const logs = await prisma.statusChangeLog.findMany({
    where: { user: { name: { not: { startsWith: 'SAMPLE_' } } } },
    orderBy: { changedAt: 'desc' },
    take: limit,
    include: { user: { include: { department: true } } },
  });
  const rows = logs.map((l) => ({
    userId: l.userId,
    name: l.user.name,
    department: l.user.department.name,
    status: l.status,
    changedAt: l.changedAt,
    source: l.source,
    note: l.note,
  }));
  return res.json({ success: true, data: rows });
});

/**
 * 2026-09-18: 다우오피스 "전사 휴가현황" 스크래핑 결과(leave-scraper.ts, 매일 오전 10시·오후 1시
 * 자동 실행) 중 특정 날짜(기본 오늘)·매칭 성공한 건만 상황판에 별도 섹션으로 보여준다. 직원의
 * 실시간 상태값(StatusChangeLog)은 전혀 건드리지 않으므로(관리자 확정 방향) 이 엔드포인트는
 * 순수 조회용이다 — 자세한 배경은 dauoffice.routes.ts의 2026-09-04/09-18 기록 참고.
 */
dashboardRouter.get('/leave-today', async (req, res) => {
  const dateParam = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  // 휴가는 근태(workDate)와 달리 새벽 3시가 아니라 달력상 그날짜 그대로다(다우오피스 "휴가사용일"도
  // 마찬가지) — dateOnlyUTC()의 3시 경계를 그대로 쓰면 자정~새벽3시 사이엔 하루 전 휴가자가
  // 보이는 어긋남이 생길 수 있어 여기서는 순수 KST 달력일로 별도 계산한다.
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const workDate = dateParam
    ? new Date(`${dateParam}T00:00:00.000Z`)
    : new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()));
  const entries = await prisma.dauofficeLeaveEntry.findMany({
    where: { workDate, matched: true },
    orderBy: [{ departmentRaw: 'asc' }, { nameRaw: 'asc' }],
  });
  const rows = entries.map((e: {
    userId: string | null; nameRaw: string; departmentRaw: string; leaveType: string;
    durationLabel: string; startTime: Date | null; endTime: Date | null;
  }) => ({
    userId: e.userId,
    name: e.nameRaw,
    department: e.departmentRaw || null,
    leaveType: e.leaveType,
    durationLabel: e.durationLabel,
    startTime: e.startTime,
    endTime: e.endTime,
  }));
  return res.json({ success: true, data: rows });
});
