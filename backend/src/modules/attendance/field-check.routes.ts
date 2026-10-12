import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly } from '../../common/attendance-helpers';
import { getPolicyString } from '../../common/policy-engine/policy-engine';
import { AUTO_CLOSE_SOURCE_STATUSES, closeEffortAt } from '../../common/effort-helpers';
import { estimateOpenEffortEnd } from './field-rules';

/**
 * 2026-10-11: "현장 기록 점검" — 관리자가 엔지니어의 위치 예외, 퇴근 위치 불일치, 자동 마무리된 작업, 입력 누락을 한 곳에서 보고
 * 과거에 종료시각 없이 남은 작업을 추정해 마무리하는 화면의 API. 조회는 TEAM_LEAD/HR_ADMIN/SYSTEM_ADMIN, 적용(쓰기)은 HR_ADMIN/SYSTEM_ADMIN.
 * 좌표는 내려주지 않는다(거리·정확도·사유만).
 */
const viewRoles = ['TEAM_LEAD', 'HR_ADMIN', 'SYSTEM_ADMIN'];
const writeRoles = ['HR_ADMIN', 'SYSTEM_ADMIN'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;
const ROW_CAP = 300;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseRange(q: any, defaultFrom: string): { from: Date; to: Date } | null {
  const fromStr = typeof q.from === 'string' && q.from ? q.from : defaultFrom;
  const toStr = typeof q.to === 'string' && q.to ? q.to : ymd(todayDateOnly());
  if (!DATE_RE.test(fromStr) || !DATE_RE.test(toStr)) return null;
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) return null;
  return { from, to };
}

function badRange(res: any) {
  return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: `기간(YYYY-MM-DD)을 확인하세요. 최대 ${MAX_RANGE_DAYS}일까지 조회할 수 있어요.` } });
}

/** 한국시간 날짜(YYYY-MM-DD)의 [시작, 다음날 시작) UTC 구간 */
function kstDayWindow(day: Date): { start: Date; end: Date } {
  const start = new Date(day.getTime() - 9 * 3600_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

async function estimateFor(e: { id: string; userId: string; sourceStatus: string | null; startTime: Date }) {
  const [nextStatus, nextEffort] = await Promise.all([
    prisma.statusChangeLog.findFirst({
      where: { userId: e.userId, changedAt: { gt: e.startTime }, ...(e.sourceStatus ? { status: { not: e.sourceStatus as any } } : {}) },
      orderBy: { changedAt: 'asc' },
      select: { changedAt: true },
    }),
    prisma.effortLog.findFirst({
      where: { userId: e.userId, id: { not: e.id }, startTime: { gt: e.startTime } },
      orderBy: { startTime: 'asc' },
      select: { startTime: true },
    }),
  ]);
  return estimateOpenEffortEnd({ startTime: e.startTime, candidates: [nextStatus?.changedAt, nextEffort?.startTime] });
}

async function loadOpenEfforts(from: Date, to: Date, ids?: string[]) {
  const today = todayDateOnly();
  const rows = await prisma.effortLog.findMany({
    where: {
      endTime: null,
      sourceStatus: { in: AUTO_CLOSE_SOURCE_STATUSES },
      workDate: { gte: from, lte: to, lt: today },
      ...(ids ? { id: { in: ids } } : {}),
    },
    orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
    take: ROW_CAP,
    select: { id: true, userId: true, workDate: true, clientName: true, workType: true, sourceStatus: true, startTime: true, description: true, user: { select: { name: true } } },
  });
  return rows as any[];
}

const applySchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export function registerFieldCheckRoutes(router: any) {
  // 종료시각 없이 남은 과거 작업과 추정 종료시각 미리보기(조회만, 아무것도 바꾸지 않는다)
  router.get('/admin/field-check/open-efforts', requireRole(...viewRoles), async (req: any, res: any) => {
    const range = parseRange(req.query, '2026-10-01');
    if (!range) return badRange(res);
    const rows = await loadOpenEfforts(range.from, range.to);
    const items = [];
    for (const e of rows) {
      const est = await estimateFor(e);
      items.push({
        id: e.id,
        userName: e.user?.name ?? '(알 수 없음)',
        workDate: ymd(e.workDate),
        clientName: e.clientName,
        workType: e.workType,
        sourceStatus: e.sourceStatus,
        startTime: e.startTime,
        hasDescription: Boolean(e.description && String(e.description).trim()),
        estimatedEnd: est.end,
        minutes: est.minutes,
        verdict: est.verdict,
      });
    }
    return res.json({ success: true, data: { items, capped: rows.length >= ROW_CAP, applicable: items.filter((i) => i.verdict === 'OK').length } });
  });

  // 선택한 건을 서버가 다시 추정해서 10시간 이내(OK)인 것만 마무리한다(클라이언트가 보낸 시각은 쓰지 않는다).
  router.post('/admin/field-check/open-efforts/apply', requireRole(...writeRoles), async (req: any, res: any) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '적용할 작업을 선택하세요.' } });
    const rows = await loadOpenEfforts(new Date('2000-01-01T00:00:00.000Z'), todayDateOnly(), parsed.data.ids);
    const applied: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const e of rows) {
      const est = await estimateFor(e);
      if (est.verdict !== 'OK' || !est.end) {
        skipped.push({ id: e.id, reason: est.verdict });
        continue;
      }
      await closeEffortAt(e.id, e.startTime, est.end, 'ADMIN_ESTIMATE');
      await recordAuditLog({
        actorUserId: req.authUser!.userId,
        actionType: 'CORRECT',
        targetType: 'effort_log',
        targetId: e.id,
        beforeValue: { endTime: null },
        afterValue: { endTime: est.end, closedBy: 'ADMIN_ESTIMATE', minutes: est.minutes },
      });
      applied.push(e.id);
    }
    const found = new Set(rows.map((r: any) => r.id));
    for (const id of parsed.data.ids) if (!found.has(id)) skipped.push({ id, reason: 'NOT_FOUND_OR_NOT_OPEN' });
    return res.json({ success: true, data: { applied: applied.length, skipped } });
  });

  // 위치 예외 / 퇴근 위치 / 자동 마무리 / 입력 누락 — 기간 내 점검 목록
  router.get('/admin/field-check/exceptions', requireRole(...viewRoles), async (req: any, res: any) => {
    const sevenAgo = ymd(new Date(todayDateOnly().getTime() - 6 * 86_400_000));
    const range = parseRange(req.query, sevenAgo);
    if (!range) return badRange(res);
    const { start } = kstDayWindow(range.from);
    const { end } = kstDayWindow(range.to);
    const contactSince = await getPolicyString('CONTACT_ENFORCED_SINCE', '2026-10-12');
    const contactSinceDate = DATE_RE.test(contactSince) ? new Date(`${contactSince}T00:00:00.000Z`) : new Date('2026-10-12T00:00:00.000Z');

    const [statusRows, clockOutRows, autoRows, incompleteRows] = await Promise.all([
      prisma.statusChangeLog.findMany({
        where: {
          changedAt: { gte: start, lt: end },
          OR: [{ locationMatch: false }, { note: { contains: '[GPS 정확도 낮음' } }, { note: { contains: '[위치 확인 불가' } }, { note: { contains: '[GPS 위치 보정' } }],
        },
        orderBy: { changedAt: 'desc' },
        take: ROW_CAP,
        select: { id: true, status: true, changedAt: true, note: true, locationMatch: true, locationDistanceMeters: true, locationAccuracyMeters: true, siteType: true, user: { select: { name: true } } },
      }),
      prisma.attendanceRecord.findMany({
        where: {
          workDate: { gte: range.from, lte: range.to },
          OR: [{ clockOutLocationMatch: false }, { clockOutLocationNote: { not: null } }],
        },
        orderBy: { workDate: 'desc' },
        take: ROW_CAP,
        select: { id: true, workDate: true, clockOutAt: true, clockOutPlace: true, clockOutLocationMatch: true, clockOutDistanceMeters: true, clockOutLocationNote: true, user: { select: { name: true } } },
      }),
      prisma.effortLog.findMany({
        where: { workDate: { gte: range.from, lte: range.to }, closedBy: { in: ['AUTO_AWAY', 'AUTO_STATUS_CHANGE', 'AUTO_CLOCKOUT', 'ADMIN_ESTIMATE'] } },
        orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
        take: ROW_CAP,
        select: { id: true, workDate: true, clientName: true, startTime: true, endTime: true, minutes: true, closedBy: true, user: { select: { name: true } } },
      }),
      prisma.effortLog.findMany({
        where: {
          workDate: { gte: range.from, lte: range.to },
          sourceStatus: { in: ['CLIENT_WORK', 'CLIENT_MEETING'] },
          endTime: { not: null },
          OR: [{ description: null }, { description: '' }, ...(range.to >= contactSinceDate ? [{ contactName: null, workDate: { gte: contactSinceDate } }] : [])],
        },
        orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
        take: ROW_CAP,
        select: { id: true, workDate: true, clientName: true, sourceStatus: true, description: true, contactName: true, user: { select: { name: true } } },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        locationExceptions: (statusRows as any[]).map((r) => ({
          id: r.id, userName: r.user?.name ?? '', status: r.status, changedAt: r.changedAt, note: r.note,
          locationMatch: r.locationMatch, distanceMeters: r.locationDistanceMeters, accuracyMeters: r.locationAccuracyMeters, siteType: r.siteType,
        })),
        clockOutExceptions: (clockOutRows as any[]).map((r) => ({
          id: r.id, userName: r.user?.name ?? '', workDate: ymd(r.workDate), clockOutAt: r.clockOutAt, place: r.clockOutPlace,
          locationMatch: r.clockOutLocationMatch, distanceMeters: r.clockOutDistanceMeters, note: r.clockOutLocationNote,
        })),
        autoClosed: (autoRows as any[]).map((r) => ({
          id: r.id, userName: r.user?.name ?? '', workDate: ymd(r.workDate), clientName: r.clientName,
          startTime: r.startTime, endTime: r.endTime, minutes: r.minutes, closedBy: r.closedBy,
        })),
        incomplete: (incompleteRows as any[]).map((r) => ({
          id: r.id, userName: r.user?.name ?? '', workDate: ymd(r.workDate), clientName: r.clientName, status: r.sourceStatus,
          missingDescription: !(r.description && String(r.description).trim()),
          missingContact: !r.contactName && r.workDate >= contactSinceDate,
        })),
        capped: [statusRows, clockOutRows, autoRows, incompleteRows].some((a: any[]) => a.length >= ROW_CAP),
      },
    });
  });

  /**
   * 2026-10-12: "퇴근·일지 점검" — 업무일지 로그 점검에서 드러난 두 가지를 한 곳에서 본다.
   *  1) 지난 근무일에 출근만 있고 퇴근이 비어 있는 기록(주로 오후 출근자) + 본인이 정정 신청을 했는지(상태).
   *  2) 퇴근은 처리됐는데 그 날 업무일지가 없는 기록(정정 경로로 닫힌 날 등) — 다우오피스 동기화분은 앱 퇴근이 아니므로 제외한다.
   * 시스템이 임의로 퇴근시각을 채우지 않는다(조회 전용). 기본 조회 기간은 최근 14일.
   */
  router.get('/admin/field-check/attendance-gaps', requireRole(...viewRoles), async (req: any, res: any) => {
    const today = todayDateOnly();
    const defaultFrom = ymd(new Date(today.getTime() - 13 * 86_400_000));
    const range = parseRange(req.query, defaultFrom);
    if (!range) return badRange(res);
    const userFilter = { employmentStatus: 'ACTIVE' as const, name: { not: { startsWith: 'SAMPLE_' } } };

    const [unclosedRows, clockedOutRows, logRows] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: { workDate: { gte: range.from, lte: range.to, lt: today }, clockInAt: { not: null }, clockOutAt: null, user: userFilter },
        orderBy: [{ workDate: 'desc' }],
        take: ROW_CAP,
        select: {
          id: true, userId: true, workDate: true, clockInAt: true, dataSource: true, user: { select: { name: true } },
          correctionRequests: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, createdAt: true } },
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { workDate: { gte: range.from, lte: range.to }, clockOutAt: { not: null }, dataSource: 'MANUAL', user: userFilter },
        orderBy: [{ workDate: 'desc' }],
        take: 12000,
        select: { id: true, userId: true, workDate: true, clockOutAt: true, isCorrected: true, user: { select: { name: true } } },
      }),
      prisma.dailyWorkLog.findMany({
        where: { workDate: { gte: range.from, lte: range.to } },
        take: 12000,
        select: { userId: true, workDate: true },
      }),
    ]);

    const logKeys = new Set((logRows as any[]).map((l) => `${l.userId}|${ymd(l.workDate)}`));
    const unclosed = (unclosedRows as any[]).map((r) => {
      const latest = r.correctionRequests?.[0] ?? null;
      return {
        id: r.id, userName: r.user?.name ?? '', workDate: ymd(r.workDate), clockInAt: r.clockInAt, dataSource: r.dataSource,
        hasWorkLog: logKeys.has(`${r.userId}|${ymd(r.workDate)}`),
        requestStatus: latest ? latest.status : 'NONE',
        requestedAt: latest ? latest.createdAt : null,
      };
    });
    const noLogAll = (clockedOutRows as any[]).filter((r) => !logKeys.has(`${r.userId}|${ymd(r.workDate)}`));
    const noLog = noLogAll.slice(0, ROW_CAP).map((r) => ({
      id: r.id, userName: r.user?.name ?? '', workDate: ymd(r.workDate), clockOutAt: r.clockOutAt, isCorrected: !!r.isCorrected,
    }));

    return res.json({
      success: true,
      data: { unclosed, noLog, capped: unclosed.length >= ROW_CAP || noLogAll.length > ROW_CAP },
    });
  });
}
