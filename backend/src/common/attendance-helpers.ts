import { prisma } from './prisma';

export function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
