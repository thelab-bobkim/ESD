import { prisma } from '../../common/prisma';
import { LOCATION_BLOCK_AUDIT_TARGET } from './location-block-audit';
import { LOCATION_FAILURE_AUDIT_TARGET } from './location-failure-audit';

/**
 * 2026-10-28: "기록 불일치 점검" — 퇴근 정정 요청을 위치 기록·마지막 활동·사유 속 시각과 대조해
 * "관리자가 확인해 볼 목록"을 만든다(판정 아님). 좌표는 내려주지 않는다.
 */
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const HOUR = 3600_000;

function reasonMinutes(text: string): number | null {
  const m1 = text.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (m1 && +m1[1] <= 24 && +m1[2] < 60) return (+m1[1] % 24) * 60 + +m1[2];
  const m2 = text.match(/(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분)?/);
  if (m2 && +m2[1] <= 24) return (+m2[1] % 24) * 60 + (m2[2] ? +m2[2] : 0);
  return null;
}

function kstMin(d: Date): number {
  return Math.floor(((d.getTime() + 9 * HOUR) % (24 * HOUR)) / 60_000);
}

export async function buildRecordConsistency(days: number) {
  const since = new Date(Date.now() - days * 24 * HOUR);
  const reqs: any[] = await prisma.attendanceCorrectionRequest.findMany({
    where: { type: 'MISSING_CLOCK_OUT', createdAt: { gte: since }, proposedClockOutAt: { not: null } },
    include: { attendanceRecord: { select: { workDate: true, clockInAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: 1500,
  });
  const userIds = [...new Set(reqs.map((r) => r.userId as string))];
  const inIds = { in: userIds };
  const users: any[] = await prisma.user.findMany({ where: { id: inIds }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id as string, u.name as string]));
  const logStart = new Date(since.getTime() - 2 * 24 * HOUR);
  const logs: any[] = await prisma.statusChangeLog.findMany({
    where: { userId: inIds, changedAt: { gte: logStart } },
    select: { userId: true, changedAt: true },
  });
  const logsByUser = new Map<string, Date[]>();
  for (const l of logs) {
    const a = logsByUser.get(l.userId) ?? [];
    a.push(l.changedAt);
    logsByUser.set(l.userId, a);
  }
  const presenceRows: any[] = await prisma.workPresenceDay.findMany({
    where: { userId: inIds, workDate: { gte: new Date(`${ymd(since)}T00:00:00.000Z`) } },
    select: { userId: true, workDate: true, lastSeenAt: true, awaySince: true },
  });
  const presenceOf = new Map(presenceRows.map((p) => [`${p.userId}|${ymd(p.workDate)}`, p]));
  const blockTargets = [LOCATION_BLOCK_AUDIT_TARGET, LOCATION_FAILURE_AUDIT_TARGET];
  const blockRows: any[] = await prisma.auditLog.findMany({
    where: { actorUserId: inIds, targetType: { in: blockTargets }, createdAt: { gte: since } },
    select: { actorUserId: true, createdAt: true },
  });
  const blockCount = new Map<string, number>();
  for (const b of blockRows) {
    const k = `${b.actorUserId}|${ymd(new Date(b.createdAt.getTime() + 6 * HOUR))}`;
    blockCount.set(k, (blockCount.get(k) ?? 0) + 1);
  }
  const rows: any[] = [];
  for (const r of reqs) {
    const name = nameOf.get(r.userId) ?? '';
    const rec = r.attendanceRecord;
    if (!name || name.startsWith('SAMPLE_') || !rec?.clockInAt) continue;
    const proposed: Date = r.proposedClockOutAt;
    const workDay = ymd(rec.workDate);
    const text = String(r.reason ?? '');
    const isAuto = text.startsWith('[위치 자동감지');
    const flags: string[] = [];
    const nineHours = rec.clockInAt.getTime() + 9 * HOUR;
    if (!isAuto && Math.abs(proposed.getTime() - nineHours) <= 60_000) flags.push('DEFAULT_9H');
    const rm = isAuto ? null : reasonMinutes(text);
    if (rm != null) {
      const d = Math.abs(rm - kstMin(proposed));
      if (Math.min(d, 1440 - d) > 20) flags.push('REASON_TIME_MISMATCH');
    }
    const dayStart = new Date(new Date(`${workDay}T00:00:00.000Z`).getTime() - 6 * HOUR);
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR);
    let lastActivityAt: Date | null = null;
    for (const t of logsByUser.get(r.userId) ?? []) {
      if (t >= dayStart && t < dayEnd && (!lastActivityAt || t > lastActivityAt)) lastActivityAt = t;
    }
    const lateMs = lastActivityAt ? lastActivityAt.getTime() - proposed.getTime() : 0;
    if (lateMs > 5 * 60_000) flags.push('ACTIVITY_AFTER');
    const pr = presenceOf.get(`${r.userId}|${workDay}`);
    const basis: Date | null = pr ? (pr.awaySince ?? pr.lastSeenAt ?? null) : null;
    const diffMin = basis ? Math.round((proposed.getTime() - basis.getTime()) / 60_000) : null;
    if (diffMin != null && Math.abs(diffMin) > 60) flags.push('PRESENCE_GAP');
    const blocks = blockCount.get(`${r.userId}|${workDay}`) ?? 0;
    if (blocks >= 3) flags.push('SYSTEM_BARRIER');
    rows.push({
      id: r.id, userName: name, workDate: workDay, clockInAt: rec.clockInAt,
      proposedClockOutAt: proposed, status: r.status, requestedAt: r.createdAt,
      isAuto, flags, lastActivityAt, presenceBasisAt: basis, presenceDiffMin: diffMin, blocks,
    });
  }
  const count = (f: string): number => rows.filter((x) => x.flags.includes(f)).length;
  interface UserAgg {
    userName: string; total: number; manual: number;
    default9h: number; mismatch: number; activityAfter: number;
  }
  const perUser = new Map<string, UserAgg>();
  for (const x of rows) {
    const u: UserAgg = perUser.get(x.userName) ?? {
      userName: x.userName, total: 0, manual: 0, default9h: 0, mismatch: 0, activityAfter: 0,
    };
    u.total += 1;
    if (!x.isAuto) u.manual += 1;
    if (x.flags.includes('DEFAULT_9H')) u.default9h += 1;
    if (x.flags.includes('REASON_TIME_MISMATCH')) u.mismatch += 1;
    if (x.flags.includes('ACTIVITY_AFTER')) u.activityAfter += 1;
    perUser.set(x.userName, u);
  }
  const score = (u: UserAgg): number => u.default9h + u.mismatch + u.activityAfter;
  return {
    days,
    summary: {
      total: rows.length,
      manual: rows.filter((x) => !x.isAuto).length,
      default9h: count('DEFAULT_9H'),
      reasonMismatch: count('REASON_TIME_MISMATCH'),
      activityAfter: count('ACTIVITY_AFTER'),
      presenceGap: count('PRESENCE_GAP'),
      withPresence: rows.filter((x) => x.presenceDiffMin != null).length,
      systemBarrier: count('SYSTEM_BARRIER'),
    },
    users: [...perUser.values()].sort((a, b) => score(b) - score(a)).slice(0, 50),
    rows: rows.slice(0, 300),
  };
}
