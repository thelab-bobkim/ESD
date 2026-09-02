import { prisma } from './prisma';

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
 * 퇴근 정정 신청(AttendanceCorrectionRequest)을 실제 근태 기록에 반영한다 — approval.routes.ts의
 * 관리자 승인 처리와 attendance.routes.ts의 "위치이탈 자동감지 → 본인 확인" 자기확정 처리가 완전히
 * 같은 계산식을 쓰도록 여기 하나로 모았다(둘이 따로 구현되면 나중에 한쪽만 고치는 사고가 나기 쉬움).
 * 신청이 없거나 이미 출근기록 자체가 없으면 null을 반환하고 아무것도 바꾸지 않는다.
 */
export async function applyAttendanceCorrection(correctionRequestId: string) {
  const correction = await prisma.attendanceCorrectionRequest.findUnique({
    where: { id: correctionRequestId },
    include: { attendanceRecord: { include: { breakSessions: true } } },
  });
  if (!correction || !correction.attendanceRecord.clockInAt) return null;

  const clockInAt = correction.attendanceRecord.clockInAt;
  const targetRecord = correction.attendanceRecord;
  const totalBreakMinutes = targetRecord.breakSessions.reduce((sum, b) => {
    if (!b.endAt) return sum;
    return sum + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000);
  }, 0);
  const grossMinutes = Math.round((correction.proposedClockOutAt.getTime() - clockInAt.getTime()) / 60000);
  const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes);

  const updatedRecord = await prisma.attendanceRecord.update({
    where: { id: targetRecord.id },
    data: {
      clockOutAt: correction.proposedClockOutAt,
      totalWorkedMinutes,
      isCorrected: true,
      correctionReason: correction.reason,
    },
  });
  await prisma.attendanceCorrectionRequest.update({ where: { id: correction.id }, data: { status: 'APPROVED' } });

  return { updatedRecord, totalWorkedMinutes, correction };
}
