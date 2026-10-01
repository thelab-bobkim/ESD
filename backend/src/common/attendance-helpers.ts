import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { getPolicyNumber, getPolicyJSON, getPolicyString } from './policy-engine/policy-engine';

/**
 * 주말(토=6,일=0, KST) 여부 — attendance.routes.ts("주말엔 주말작업만" 게이트)와
 * reminder-scheduler.ts(주말엔 미출근/미퇴근 알림을 아예 보내지 않음) 양쪽에서 같은 기준을 써야
 * 하므로 원래 attendance.routes.ts에만 있던 걸 여기 하나로 모았다(2026-09-14).
 */
export function isWeekendKST(date: Date = new Date()): boolean {
  const kstDay = new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCDay();
  return kstDay === 0 || kstDay === 6;
}

/**
 * 2026-09-30 발견/수정: "주말엔 주말작업만" 게이트(attendance.routes.ts)가 지금까지
 * isWeekendKST()(자정 기준 실제 달력요일)를 그대로 썼는데, workDate/todayDateOnly()는 새벽
 * 3시를 하루 경계로 삼는다 — 두 기준이 어긋나 있었다. 그래서 금요일 야간작업을 하다 토요일
 * 03시 이전(workDate는 아직 "금요일")에 상태를 다시 등록하려 하면 isWeekendKST()는 "토요일"로
 * 보고 WEEKEND_ONLY_WEEKEND_WORK로 막아버렸다(야간작업자가 새벽에도 상태를 등록/수정할 수
 * 있어야 한다는 기존 방침과 정면으로 어긋남). 반대로 월요일 00~03시(workDate는 아직 "일요일")엔
 * 평일로 오인되어 주말작업이 막히는 등, 자정 전후 3시간 구간에서 요일 판정이 실제 근무일과
 * 어긋났다. workDate(이미 3시 경계로 보정된 Date.UTC 날짜)의 요일을 그대로 보면 이 어긋남이
 * 사라진다 — isWeekendKST()는 그대로 두고(reminder-scheduler.ts 등 실제 달력요일이 맞는
 * 곳도 있음) "근무일 기준" 주말판정이 필요한 곳에서만 이 함수를 쓴다.
 */
export function isWeekendForWorkDate(workDate: Date): boolean {
  const day = workDate.getUTCDay();
  return day === 0 || day === 6;
}

// 2026-09-14: "주말/공휴일에도 출근 알림이 계속 온다"는 신고(김진호·김진영·권성주) 반영 —
// 관공서의 공휴일에 관한 규정 기준 2026년 법정공휴일 기본값(대체공휴일·근로자의 날 포함).
// 연도가 바뀌거나 회사 창립기념일 같은 회사만의 휴일을 추가해야 하면, 정책값
// PUBLIC_HOLIDAYS_KST(JSON 문자열 배열, "YYYY-MM-DD")로 이 기본값 전체를 덮어쓸 수 있다.
const DEFAULT_PUBLIC_HOLIDAYS_KST_2026 = [
  '2026-01-01', // 신정
  '2026-02-16', '2026-02-17', '2026-02-18', // 설날 연휴
  '2026-03-01', // 삼일절
  '2026-03-02', // 삼일절 대체공휴일
  '2026-05-01', // 근로자의 날 (전 사업장 유급휴일)
  '2026-05-05', // 어린이날
  '2026-05-24', // 부처님오신날
  '2026-05-25', // 부처님오신날 대체공휴일
  '2026-06-06', // 현충일
  '2026-08-15', // 광복절
  '2026-08-17', // 광복절 대체공휴일
  '2026-09-24', '2026-09-25', '2026-09-26', // 추석 연휴
  '2026-10-03', // 개천절
  '2026-10-05', // 개천절 대체공휴일
  '2026-10-09', // 한글날
  '2026-12-25', // 크리스마스
];

/** Date를 "YYYY-MM-DD"(KST 기준 날짜) 문자열로 변환한다 — 공휴일 목록 대조용. */
function kstDateKey(date: Date): string {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** 오늘(또는 주어진 날짜)이 정책값 PUBLIC_HOLIDAYS_KST(없으면 기본 2026년 목록) 기준 공휴일인지. */
export async function isPublicHolidayKST(date: Date = new Date()): Promise<boolean> {
  const holidays = await getPolicyJSON<string[]>('PUBLIC_HOLIDAYS_KST', DEFAULT_PUBLIC_HOLIDAYS_KST_2026);
  return holidays.includes(kstDateKey(date));
}

/**
 * "오늘"의 workDate를 계산한다. 자정이 아니라 새벽 3시(KST)를 하루의 경계로 삼는다 —
 * 야간작업자가 새벽 1~2시까지 일하는 경우가 많아서, 자정을 넘겨도 "어제"로 계속 잡히게 하기 위함.
 * (새벽 3시가 지나야 비로소 "새 하루"로 넘어가며, 그때부터 출근 버튼 등이 다시 활성화된다.)
 */
export function todayDateOnly(): Date {
  const now = new Date();
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  return new Date(Date.UTC(kstShifted.getUTCFullYear(), kstShifted.getUTCMonth(), kstShifted.getUTCDate()));
}

/**
 * workDate 라벨(위 todayDateOnly()가 반환하는, "그 날짜"를 나타내는 UTC자정 Date)이 실제로
 * 가리키는 "진짜 시간 범위"를 계산한다. 하루의 경계가 자정이 아니라 새벽 3시(KST)이므로,
 * workDate로 표시된 날의 실제 범위는 [그 날짜 UTC자정 - 6시간, +18시간) = KST 새벽3시~다음날 새벽3시다.
 * status_change_logs.changed_at 처럼 "실제 타임스탬프" 컬럼을 이 범위로 걸러야 할 때 반드시 이 함수를 써야
 * 한다 — workDate ~ workDate+24시간으로 그냥 계산하면 새벽 3시 이전에 등록된 기록이 빠져버린다.
 */
export function realDayWindow(workDateLabel: Date): { start: Date; end: Date } {
  const start = new Date(workDateLabel.getTime() - 6 * 60 * 60 * 1000);
  const end = new Date(workDateLabel.getTime() + 18 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * 주52시간제 대응: "출근"의 시작을 실제 업무 시작 시점(본사근무/고객사상주/고객사미팅/고객사작업
 * 상태로 바뀌거나 고객사 도착체크)으로 자동 인식한다. 그날 이미 출근 기록이 있으면 아무것도 하지
 * 않는다 — 그날 가장 먼저 "일을 시작한" 시점만 출근시각으로 남는다. 실질적인 하루 근무 종료(퇴근
 * 버튼)는 attendance.routes.ts의 /clock-out에서 별도로 처리한다.
 */
export async function ensureClockIn(userId: string): Promise<void> {
  const workDate = todayDateOnly();
  const existing = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate } } });
  if (existing?.clockInAt) return;
  if (existing) {
    await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt: new Date() } });
  } else {
    await prisma.attendanceRecord.create({ data: { userId, workDate, clockInAt: new Date() } });
  }
}

/**
 * workDate(그 날짜를 나타내는 UTC 자정)와 "HH:MM"(한국시간 기준)을 조합해 실제 UTC 시각을 만든다.
 * 회사가 한국(KST, UTC+9) 소재이므로 KST 시각을 UTC로 환산한다.
 */
export function combineDateTime(workDate: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map((n) => Number(n));
  const y = workDate.getUTCFullYear();
  const mo = workDate.getUTCMonth();
  const d = workDate.getUTCDate();
  return new Date(Date.UTC(y, mo, d, h - 9, m));
}

/**
 * 종료시각이 시작시각보다 이르면(예: 22:00 시작 ~ 02:00 종료) 자정을 넘겨 다음날로 넘어간
 * 것으로 보고 하루(24시간)를 더해준다. 야간작업처럼 자정을 넘기는 근무를 정확히 계산하기 위함.
 */
export function resolveEndTime(startTime: Date, endTime: Date): Date {
  if (endTime.getTime() >= startTime.getTime()) return endTime;
  return new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * 하루 근무시간 계산 시 점심시간(정책값 LUNCH_BREAK_DEDUCTION_MINUTES, 기본 60분)을 고정으로
 * 공제한다. 직원이 별도로 찍는 휴식(break) 세션과는 별개로, "8시간 근무에는 점심 1시간이
 * 포함되어 있지 않다"는 요청(2026-09-14)에 따라 총 근무시간에서 항상 빼는 값이다.
 * /clock-out과 applyAttendanceCorrection() 두 곳이 똑같은 계산식을 쓰도록 여기 하나로 모았다.
 */
export async function getLunchBreakMinutes(): Promise<number> {
  return getPolicyNumber('LUNCH_BREAK_DEDUCTION_MINUTES', 60);
}

// 2026-09-18: 경영관리부 요청 — 공수(고객사별 청구시간)에서 "실 공수시간"을 자동 산정할 때는
// 근태처럼 "하루 1회 무조건 60분"이 아니라, 정책에 정한 점심시간대(기본 12:00~13:00, KST)와
// 그 공수기록의 시작~종료 시각이 실제로 겹치는 만큼만 뺀다(사용자 확인 완료 — "정책에 정한
// 점심시간대와 실제로 겹칠 때만 차감" 선택). 예: 09~11시 단독 등록엔 안 빠지고, 11~14시 등록엔
// 겹치는 1시간만 빠진다. effort-helpers.ts recordEffort()가 이 값을 실공수시간(actualMinutes)
// 계산에 쓴다.
export async function getLunchWindowKST(): Promise<{ startHHMM: string; endHHMM: string }> {
  const startHHMM = await getPolicyString('LUNCH_BREAK_START_HHMM', '12:00');
  const endHHMM = await getPolicyString('LUNCH_BREAK_END_HHMM', '13:00');
  return { startHHMM, endHHMM };
}

function hhmmToMinutesOfDay(hhmm: string): number {
  const parts = hhmm.split(':').map((v) => Number(v));
  const h = parts[0];
  const m = parts[1];
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/**
 * [start, end) 구간(실제 Date, UTC 내부값)이 KST 기준 점심시간대와 겹치는 분(minute) 수를 계산한다.
 * 대부분의 공수기록은 하루 안에서 끝나지만, 혹시 자정을 넘기는 기록(예: 심야 재택근무)이 있어도
 * 안전하게 계산되도록 날짜별로 훑으면서 그날그날의 점심시간 구간과 겹치는 만큼을 합산한다.
 */
export function lunchOverlapMinutes(
  start: Date,
  end: Date,
  lunchWindow: { startHHMM: string; endHHMM: string }
): number {
  if (!start || !end || end <= start) return 0;
  const lunchStartMin = hhmmToMinutesOfDay(lunchWindow.startHHMM);
  const lunchEndMin = hhmmToMinutesOfDay(lunchWindow.endHHMM);
  if (lunchEndMin <= lunchStartMin) return 0; // 잘못된 정책값(끝이 시작보다 빠름) 방어

  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  let totalOverlap = 0;
  let cursor = new Date(start);
  // 무한루프 방지 겸 비정상적으로 긴 구간(수년치 등)에 대비한 안전장치.
  let guard = 0;
  while (cursor < end && guard < 3650) {
    guard += 1;
    const kst = new Date(cursor.getTime() + KST_OFFSET_MS);
    const dayStartKST = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
    const lunchStartUTC = new Date(dayStartKST + lunchStartMin * 60000 - KST_OFFSET_MS);
    const lunchEndUTC = new Date(dayStartKST + lunchEndMin * 60000 - KST_OFFSET_MS);
    const overlapStart = start > lunchStartUTC ? start : lunchStartUTC;
    const overlapEnd = end < lunchEndUTC ? end : lunchEndUTC;
    if (overlapEnd > overlapStart) {
      totalOverlap += Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 60000);
    }
    // 다음 날 KST 자정(=UTC로 환산한 시각)으로 이동.
    cursor = new Date(dayStartKST + 24 * 60 * 60 * 1000 - KST_OFFSET_MS);
  }
  return totalOverlap;
}

/**
 * 최소근무시간(정책값 MIN_HOURS_BEFORE_CLOCKOUT, 기본 8시간) 미충족 여부를 확인한다.
 * 원래 /clock-out(수동 퇴근)에만 있던 규칙인데, "위치이탈 자동감지"로 확정되는 퇴근(본인 확인
 * 또는 관리자 승인)도 결국 같은 attendance_records.clock_out_at을 채우는 것이므로 이 규칙을
 * 피해갈 수 없어야 한다 — 2026-09-08, 김진호의 출근 1분 뒤/2시간 뒤 퇴근이 사유 확인 없이 그대로
 * 확정돼버린 사고로 발견됨(자동감지 → 관리자 승인 경로가 이 검사를 완전히 건너뛰고 있었음).
 */
export async function checkMinWorkedMinutes(
  clockInAt: Date,
  proposedClockOutAt: Date
): Promise<{ ok: boolean; remainMinutes: number }> {
  const minMinutes = (await getPolicyNumber('MIN_HOURS_BEFORE_CLOCKOUT', 8)) * 60;
  const elapsedMinutes = Math.round((proposedClockOutAt.getTime() - clockInAt.getTime()) / 60000);
  return { ok: elapsedMinutes >= minMinutes, remainMinutes: Math.max(0, minMinutes - elapsedMinutes) };
}

/**
 * 퇴근 정정 신청(AttendanceCorrectionRequest)을 실제 근태 기록에 반영한다 — approval.routes.ts의
 * 관리자 승인 처리와 attendance.routes.ts의 "위치이탈 자동감지 → 본인 확인" 자기확정 처리가 완전히
 * 같은 계산식을 쓰도록 여기 하나로 모았다(둘이 따로 구현되면 나중에 한쪽만 고치는 사고가 나기 쉬움).
 * 신청이 없거나 이미 출근기록 자체가 없으면 null을 반환하고 아무것도 바꾸지 않는다.
 * earlyLeaveReason: 최소근무시간 미충족 상태로 확정하는 경우의 사유(본인이 입력했거나, 관리자
 * 승인 시 남긴 코멘트) — /clock-out과 동일하게 근태기록에 남겨서 왜 짧게 확정됐는지 추적 가능하게 한다.
 */
export async function applyAttendanceCorrection(
  correctionRequestId: string,
  earlyLeaveReason?: string,
  // 2026-09-30 수정(Medium): 승인 처리처럼 여러 쓰기를 한 트랜잭션으로 묶어야 하는 호출부가
  // 이 함수를 그대로 재사용할 수 있도록 클라이언트를 주입받는다(기본값은 전역 prisma).
  client: Prisma.TransactionClient = prisma
) {
  const correction = await client.attendanceCorrectionRequest.findUnique({
    where: { id: correctionRequestId },
    include: { attendanceRecord: { include: { breakSessions: true } } },
  });
  if (!correction || !correction.attendanceRecord.clockInAt) return null;

  const targetRecord = correction.attendanceRecord;

  // 2026-09-16: "오늘 퇴근 취소" 신청 — 새 퇴근시각을 확정하는 게 아니라, 실수로 처리된 퇴근을
  // 완전히 되돌려서 다시 근무중 상태로 만든다. 퇴근 관련 필드를 전부 비워서 attendance.routes.ts의
  // /clock-out을 다시 정상적으로 탈 수 있게 한다(단, isCorrected/correctionReason은 남겨서
  // "이 기록은 한 번 정정됐다"는 흔적을 감사로그와 별개로 근태 기록 자체에도 남긴다).
  if (correction.type === 'CANCEL_CLOCK_OUT') {
    const updatedRecord = await client.attendanceRecord.update({
      where: { id: targetRecord.id },
      data: {
        clockOutAt: null,
        totalWorkedMinutes: null,
        clockOutLocation: null,
        clockOutLocationStatus: null,
        earlyLeaveReason: null,
        isCorrected: true,
        correctionReason: correction.reason,
      },
    });
    await client.attendanceCorrectionRequest.update({ where: { id: correction.id }, data: { status: 'APPROVED' } });
    return { updatedRecord, totalWorkedMinutes: null as number | null, correction };
  }

  // 기존 "지난 근무일 퇴근 누락" 정정 — proposedClockOutAt이 항상 채워져 있다(요청 생성 시 필수값).
  if (!correction.proposedClockOutAt) return null;
  const proposedClockOutAt = correction.proposedClockOutAt;
  const clockInAt = correction.attendanceRecord.clockInAt;
  const totalBreakMinutes = targetRecord.breakSessions.reduce((sum, b) => {
    if (!b.endAt) return sum;
    return sum + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000);
  }, 0);
  const grossMinutes = Math.round((proposedClockOutAt.getTime() - clockInAt.getTime()) / 60000);
  const lunchBreakMinutes = await getLunchBreakMinutes();
  const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes - lunchBreakMinutes);

  const updatedRecord = await client.attendanceRecord.update({
    where: { id: targetRecord.id },
    data: {
      clockOutAt: proposedClockOutAt,
      totalWorkedMinutes,
      isCorrected: true,
      correctionReason: correction.reason,
      ...(earlyLeaveReason ? { earlyLeaveReason } : {}),
    },
  });
  await client.attendanceCorrectionRequest.update({ where: { id: correction.id }, data: { status: 'APPROVED' } });

  return { updatedRecord, totalWorkedMinutes: totalWorkedMinutes as number | null, correction };
}

// "출근" 버튼을 눌렀는데 그날 상태를 하나도 안 골랐으면(attendance.routes.ts /clock-in), 위치확인
// 성공 여부와 무관하게 일단 HQ_WORKING으로 채워 넣는 잠정 값에 붙이는 안내문구다. 이 문구가 붙은
// 기록은 "본인이 실제로 본사근무를 선택해서 확정된 것"이 아니라 "출근 버튼만 누르고 방치된 상태"이므로,
// 상황판에서 이 둘을 구분해서 보여줘야 한다(2026-09-16, "본사근무 라벨인데 거리가 수십km"라는 관리자
// 문의로 발견 — 김용태·손지원·임규동 사례). 쓰는 쪽(attendance.routes.ts)과 읽는 쪽
// (dashboard.routes.ts)이 정확히 같은 문자열을 봐야 하므로 여기 하나로 모은다.
export const PROVISIONAL_HQ_NOTE = '출근 버튼 클릭 시 잠정 설정(실제 상태로 바꾸면 그 값이 우선함)';

// 물리적으로 다른 장소를 오가는 상태들 — "이동중"을 명시적으로 찍지 않고 바로 다음 장소 상태로
// 넘어간 경우, 이 상태들 사이의 구간에서만 이동시간을 자동으로 추정한다. 재택/야간작업/출장/
// 대체휴무 등은 물리적 이동 대상이 아니라 제외한다(2026-09-06).
const LOCATION_TIED_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_WORK', 'CLIENT_MEETING']);

// 이 상태들로 처음 바뀌면 "실제 업무 시작"으로 보고 ensureClockIn()이 출근시각을 자동으로 찍는다
// (attendance.routes.ts의 /status 핸들러가 이 Set을 그대로 가져다 쓴다 — 두 곳에 따로 유지하면
// 나중에 한쪽만 고치는 사고가 나기 쉬워서 여기 하나로 모았다).
export const WORK_START_STATUSES = new Set([
  'HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK', 'BUSINESS_TRIP', 'REMOTE',
]);

export interface RawStatusLog { status: string; changedAt: Date; note: string | null; }
export interface TimelineSegment {
  status: string; changedAt: Date; note: string | null; durationMinutes: number; ongoing: boolean;
  // 본인이 실제로 찍은 기록이 아니라, 이동시간 미기록 구간에서 시스템이 자동으로 떼어낸 추정치인지 여부.
  estimated?: boolean;
}

export interface ClockInMismatch { firstWorkStatus: string; firstWorkAt: Date; diffMinutes: number | null; }

/**
 * 출근시각(attendance_records.clock_in_at)은 WORK_START_STATUSES로 처음 바뀌는 순간
 * ensureClockIn()이 자동으로 찍는다 — 정상적이라면 그날 첫 근무기록 시각과 항상 거의 일치해야
 * 한다. 그런데 그 둘이 눈에 띄게 어긋나 있거나(정책값 변경 이력, 수동 DB 정정 등), 근무기록은
 * 있는데 출근시각 자체가 비어 있으면 관리자가 "분명 새벽에 일한 기록이 있는데 출근은 왜 없지?"
 * 처럼 혼란스러워한다(2026-09-08, 손주용의 새벽 근무기록 사례로 발견) — 원인을 코드로 완전히
 * 재현하지는 못했지만, 최소한 관리자 화면에서 이 불일치 자체는 바로 눈에 띄게 만들어서 개별
 * 확인·정정이 필요한 케이스를 놓치지 않게 한다. 오차 허용범위(5분) 이내는 정상으로 보고 null.
 */
export function computeClockInMismatch(logs: RawStatusLog[], clockInAt: Date | null): ClockInMismatch | null {
  const firstWorkLog = logs.find((l) => WORK_START_STATUSES.has(l.status));
  if (!firstWorkLog) return null;
  if (!clockInAt) {
    return { firstWorkStatus: firstWorkLog.status, firstWorkAt: firstWorkLog.changedAt, diffMinutes: null };
  }
  const diffMinutes = Math.round(Math.abs(firstWorkLog.changedAt.getTime() - clockInAt.getTime()) / 60000);
  return diffMinutes > 5 ? { firstWorkStatus: firstWorkLog.status, firstWorkAt: firstWorkLog.changedAt, diffMinutes } : null;
}

/**
 * 하루치 상태변경 로그를 순서대로 훑어서 구간별 소요시간을 계산한다. 좌표를 저장하지 않는 설계상
 * (core_principles) 실제 이동경로/이동시간은 알 수 없으므로, 직원이 "이동중"을 안 찍고 바로 다음
 * 장소(본사/고객사) 상태로 넘어간 구간에 한해 정책값(DEFAULT_TRAVEL_MINUTES, 기본 30분)만큼을
 * 그 구간 끝에서 "이동(자동추정)"으로 떼어내고 나머지를 원래 상태의 실제 시간으로 계산한다.
 * 2026-09-06: 직원들이 바빠서 이동중 상태를 잘 안 찍다 보니 이동시간이 근무시간에 섞여 들어가고
 * 공수 산정이 부정확해진다는 요청으로 추가 — 대략치라도 이동시간이 아예 0으로 잡히는 것보다는
 * 공수 산정에 훨씬 가깝다는 판단(사용자 확인 완료).
 */
export function computeTimelineSegments(
  logs: RawStatusLog[],
  recordClockOutAt: Date | null,
  defaultTravelMinutes: number
): { segments: TimelineSegment[]; totalTravelMinutes: number; hasEstimatedTravel: boolean } {
  const segments: TimelineSegment[] = [];
  let totalTravelMinutes = 0;
  let hasEstimatedTravel = false;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const next = logs[i + 1] ?? null;
    const nextChangedAt: Date | null = next?.changedAt ?? recordClockOutAt ?? null;
    const ongoing = !nextChangedAt;
    const endTime = nextChangedAt ?? new Date();
    const gapMinutes = Math.max(0, Math.round((endTime.getTime() - log.changedAt.getTime()) / 60000));

    const shouldInferTravel = !ongoing && next !== null
      && LOCATION_TIED_STATUSES.has(log.status) && LOCATION_TIED_STATUSES.has(next.status)
      && gapMinutes > 0;
    const inferredTravel = shouldInferTravel ? Math.min(defaultTravelMinutes, gapMinutes) : 0;

    segments.push({ status: log.status, changedAt: log.changedAt, note: log.note, durationMinutes: gapMinutes - inferredTravel, ongoing });

    if (inferredTravel > 0) {
      segments.push({
        status: 'MOVING',
        changedAt: new Date(endTime.getTime() - inferredTravel * 60000),
        note: null,
        durationMinutes: inferredTravel,
        ongoing: false,
        estimated: true,
      });
      totalTravelMinutes += inferredTravel;
      hasEstimatedTravel = true;
    }
  }

  // 본인이 직접 찍은 "이동중" 구간(자동추정이 아닌)도 이동시간 합계에 포함한다.
  totalTravelMinutes += segments
    .filter((s) => s.status === 'MOVING' && !s.estimated && !s.ongoing)
    .reduce((sum, s) => sum + s.durationMinutes, 0);

  return { segments, totalTravelMinutes, hasEstimatedTravel };
}
