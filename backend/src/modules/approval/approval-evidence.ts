import { prisma } from '../../common/prisma';
import { realDayWindow } from '../../common/attendance-helpers';

// 2026-10-28: 승인함의 정정 요청에 승인 판단 근거를 붙인다(조회 전용).
const GRACE_MINUTES = 10;

export async function addApprovalEvidence(requests: any[]) {
  return Promise.all(requests.map(async (r: any) => {
    const c = r.attendanceCorrectionRequest;
    const rec = c?.attendanceRecord;
    if (r.type !== 'ATTENDANCE_CORRECTION' || !c?.proposedClockOutAt || !rec) return r;
    const proposed = new Date(c.proposedClockOutAt);
    const { start, end } = realDayWindow(rec.workDate);
    const userId = r.requester.id;
    const graceEnd = new Date(proposed.getTime() + GRACE_MINUTES * 60000);
    const before = await prisma.statusChangeLog.findFirst({
      where: { userId, changedAt: { gte: start, lte: proposed } },
      orderBy: { changedAt: 'desc' },
      select: { changedAt: true },
    });
    const after = await prisma.statusChangeLog.findFirst({
      where: { userId, changedAt: { gt: graceEnd, lt: end } },
      orderBy: { changedAt: 'desc' },
      select: { changedAt: true },
    });
    const nineHours = new Date(rec.clockInAt).getTime() + 9 * 3600000;
    const diff = Math.abs(proposed.getTime() - nineHours);
    const isDefault9h = rec.clockInAt ? diff <= 60000 : false;
    const warnings: string[] = [];
    if (isDefault9h) warnings.push('신청 시각이 출근+9시간 기본값과 같아요');
    if (after) warnings.push('신청한 퇴근 시각 이후에도 활동 기록이 있어요');
    if (!before) warnings.push('신청 시각 이전에 남은 활동 기록이 없어요');
    const evidence = {
      isDefault9h,
      lastActivityBeforeAt: before?.changedAt ?? null,
      lastActivityAfterAt: after?.changedAt ?? null,
      warnings,
    };
    return { ...r, evidence };
  }));
}
