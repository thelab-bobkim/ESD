import { prisma } from '../../common/prisma';

export interface EvidenceCandidate { source: string; label: string; at: string }

/**
 * 퇴근 정정 때 보여줄 "기록에서 찾은 시각" 후보(2026-11-01). 참고용이며 시스템이 퇴근시각을 대신 정하지 않는다 —
 * 직원이 누르면 입력칸에 채워지고, 다르면 직접 고친다. 근거가 없으면 빈 목록을 돌려준다.
 * (상태 변경 기록만으로는 퇴근 시각을 알 수 없다 — 대부분 아침에 한 번 등록하고 끝나기 때문이다.)
 */
export async function buildCorrectionEvidence(userId: string, recordId: string): Promise<EvidenceCandidate[]> {
  const rec = await prisma.attendanceRecord.findFirst({
    where: { id: recordId, userId },
    select: { workDate: true, clockInAt: true },
  });
  if (!rec || !rec.clockInAt) return [];
  const from = rec.clockInAt.getTime() + 30 * 60_000;
  const out: EvidenceCandidate[] = [];
  const effort = await prisma.effortLog.findFirst({
    where: { userId, workDate: rec.workDate, endTime: { not: null } },
    orderBy: { endTime: 'desc' },
    select: { endTime: true, clientName: true },
  });
  if (effort?.endTime && effort.endTime.getTime() >= from) {
    const who = effort.clientName ? ` (${effort.clientName})` : '';
    out.push({ source: 'EFFORT_END', label: `공수 기록 종료${who}`, at: effort.endTime.toISOString() });
  }
  const last = await prisma.statusChangeLog.findFirst({
    where: { userId, changedAt: { gt: new Date(from), lt: new Date(rec.clockInAt.getTime() + 20 * 3600_000) } },
    orderBy: { changedAt: 'desc' },
    select: { changedAt: true },
  });
  if (last) out.push({ source: 'LAST_STATUS', label: '마지막 상태 변경', at: last.changedAt.toISOString() });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
