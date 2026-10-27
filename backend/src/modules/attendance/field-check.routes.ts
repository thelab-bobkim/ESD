import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { todayDateOnly } from '../../common/attendance-helpers';
import { getPolicyString } from '../../common/policy-engine/policy-engine';
import { AUTO_CLOSE_SOURCE_STATUSES, closeEffortAt } from '../../common/effort-helpers';
import { estimateOpenEffortEnd } from './field-rules';
import { parseClientFromNote, clusterMismatchPoints, classifyHotspots, summarizeBlockedEvents, type MismatchPoint, type BlockedEvent } from './location-hotspots';
import { LOCATION_BLOCK_AUDIT_TARGET } from './location-block-audit';
import { analyzeWorkLogs, type QualityLogInput, type QualityAttendanceInput, type QualityEffortInput } from '../daily-work-log/work-log-quality';
import { LOCATION_FAILURE_AUDIT_TARGET, classifyDevice, summarizeLocationFailures, type FailureEvent, type FailureEndpoint } from './location-failure-audit';

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
/** SAMPLE_ 테스트 계정(시스템관리자 등)의 기록은 점검 대상이 아니므로 모든 조회에서 뺀다. */
const NOT_SAMPLE_USER = { name: { not: { startsWith: 'SAMPLE_' } } };

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
      user: NOT_SAMPLE_USER,
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
          user: NOT_SAMPLE_USER,
          OR: [{ locationMatch: false }, { note: { contains: '[GPS 정확도 낮음' } }, { note: { contains: '[위치 확인 불가' } }, { note: { contains: '[GPS 위치 보정' } }, { note: { contains: '[내 현재 위치로 등록' } }],
        },
        orderBy: { changedAt: 'desc' },
        take: ROW_CAP,
        select: { id: true, status: true, changedAt: true, note: true, locationMatch: true, locationDistanceMeters: true, locationAccuracyMeters: true, siteType: true, user: { select: { name: true } } },
      }),
      prisma.attendanceRecord.findMany({
        where: {
          workDate: { gte: range.from, lte: range.to },
          user: NOT_SAMPLE_USER,
          OR: [{ clockOutLocationMatch: false }, { clockOutLocationNote: { not: null } }],
        },
        orderBy: { workDate: 'desc' },
        take: ROW_CAP,
        select: { id: true, workDate: true, clockOutAt: true, clockOutPlace: true, clockOutLocation: true, clockOutLocationMatch: true, clockOutDistanceMeters: true, clockOutLocationNote: true, user: { select: { name: true } } },
      }),
      prisma.effortLog.findMany({
        where: { workDate: { gte: range.from, lte: range.to }, user: NOT_SAMPLE_USER, closedBy: { in: ['AUTO_AWAY', 'AUTO_STATUS_CHANGE', 'AUTO_CLOCKOUT', 'ADMIN_ESTIMATE'] } },
        orderBy: [{ workDate: 'desc' }, { startTime: 'desc' }],
        take: ROW_CAP,
        select: { id: true, workDate: true, clientName: true, startTime: true, endTime: true, minutes: true, closedBy: true, user: { select: { name: true } } },
      }),
      prisma.effortLog.findMany({
        where: {
          workDate: { gte: range.from, lte: range.to },
          user: NOT_SAMPLE_USER,
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
          area: r.clockOutPlace === 'OTHER' ? ((s: string | null) => { const t = (s ?? '').trim().split(/\s+/).filter(Boolean); if (t.length === 0) return null; const n = t.length >= 3 && t[1].endsWith('시') && t[2].endsWith('구') ? 3 : Math.min(2, t.length); return t.slice(0, n).join(' '); })(r.clockOutLocation) : null,
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

  /**
   * 2026-10-13: "방문지 점검" — 같은 장소에서 여러 명이 반복해서 위치 불일치가 나는지 본다(직원 실수보다 고객사 등록 좌표/미등록 방문지가 원인일 수 있다).
   *  1) hotspots: 불일치로 남은 위치(보관기간 30일 이내, 관리자 전용 좌표)를 300m 단위로 묶어 "미등록 방문지 후보" / "등록 고객사 근처인데 어긋남"을 가려낸다.
   *  2) blocked: 엄격 모드로 등록이 막힌 시도(좌표 없이 고객사명·거리·단계만 기록)를 고객사별로 모아 여러 명이 반복해서 막히는 고객사를 가려낸다.
   * 좌표를 쓰므로 관리자(HR_ADMIN/SYSTEM_ADMIN)만 볼 수 있고 조회는 감사로그(LOCATION_DETAIL_VIEW)에 남긴다. 묶음 중심은 약 100m 단위로만 내려준다.
   */
  router.get('/admin/field-check/location-hotspots', requireRole(...writeRoles), async (req: any, res: any) => {
    const daysRaw = Number(req.query?.days);
    const days = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, Math.floor(daysRaw))) : 14;
    const since = new Date(Date.now() - days * 86_400_000);
    const [mismatchRows, blockRows, clients, hqLat, hqLng] = await Promise.all([
      prisma.statusChangeLog.findMany({
        where: { changedAt: { gte: since }, locationMatch: false, mismatchLatitude: { not: null }, mismatchLongitude: { not: null }, user: NOT_SAMPLE_USER },
        orderBy: { changedAt: 'desc' },
        take: 2000,
        select: {
          userId: true, status: true, changedAt: true, note: true, mismatchLatitude: true, mismatchLongitude: true,
          // 상주 직원은 배정 고객사(상주지) 근처 기록을 문제 장소에서 뺀다.
          user: { select: { name: true, assignedClient: { select: { latitude: true, longitude: true } } } },
        },
      }),
      prisma.auditLog.findMany({
        where: { targetType: LOCATION_BLOCK_AUDIT_TARGET, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 3000,
        select: { actorUserId: true, afterValue: true },
      }),
      prisma.client.findMany({ select: { name: true, latitude: true, longitude: true } }),
      getPolicyString('HQ_LATITUDE', ''),
      getPolicyString('HQ_LONGITUDE', ''),
    ]);

    const points: MismatchPoint[] = (mismatchRows as any[]).map((r) => ({
      userId: r.userId, userName: r.user?.name ?? '', lat: Number(r.mismatchLatitude), lng: Number(r.mismatchLongitude),
      changedAt: r.changedAt, status: r.status, clientName: parseClientFromNote(r.note),
      residentLat: r.user?.assignedClient?.latitude ?? null, residentLng: r.user?.assignedClient?.longitude ?? null,
    }));
    const hq = hqLat && hqLng && Number.isFinite(Number(hqLat)) && Number.isFinite(Number(hqLng)) ? { lat: Number(hqLat), lng: Number(hqLng) } : null;
    const { hotspots, hqAreaClusters, residentAreaClusters } = classifyHotspots(clusterMismatchPoints(points), clients as any[], hq);

    const actorIds = [...new Set((blockRows as any[]).map((r) => r.actorUserId).filter((x: any): x is string => !!x))];
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const actorName = new Map((actors as any[]).map((u) => [u.id, u.name as string]));
    const events: BlockedEvent[] = [];
    let correctedFailed = 0;
    for (const r of blockRows as any[]) {
      const v = (r.afterValue ?? {}) as any;
      if (v.kind !== 'CLIENT' && v.kind !== 'HQ') continue;
      if ((actorName.get(r.actorUserId) ?? '').startsWith('SAMPLE_')) continue;
      if (v.phase === 'CORRECTED_FAILED') correctedFailed += 1;
      events.push({
        userId: r.actorUserId ?? '', userName: actorName.get(r.actorUserId) ?? '', kind: v.kind,
        clientName: typeof v.clientName === 'string' ? v.clientName : null,
        distanceMeters: typeof v.distanceMeters === 'number' ? v.distanceMeters : null,
      });
    }
    const blocked = summarizeBlockedEvents(events);

    await recordAuditLog({ actorUserId: req.authUser?.userId ?? null, actionType: 'LOCATION_DETAIL_VIEW', targetType: 'location_hotspots', afterValue: { days, hotspots: hotspots.length } });

    return res.json({
      success: true,
      data: {
        days,
        hotspots,
        hqAreaClusters,
        residentAreaClusters,
        mismatchPointCount: points.length,
        blocked: { ...blocked, total: events.length, correctedFailed },
        capped: mismatchRows.length >= 2000 || blockRows.length >= 3000,
      },
    });
  });

  /**
   * 2026-10-15: "위치 확인 실패 기록" — 위치 문제로 거절된 출근/상태 등록 시도(좌표 없음)를 기기(PC/휴대폰)·오류 종류·직원별로 모아 보여준다.
   * "PC로 출근이 여러 번 안 됐다" 같은 신고의 원인(GPS 오차, 위치 권한, 본사에서 떨어짐 등)을 직원이 설명하지 않아도 확인할 수 있게 한다.
   */
  // 2026-10-27: "내 현재 위치로 등록"한 엔지니어 분석 — 어떤 직원·기기·OS·통신 환경에서 위치 오차가 반복되는지 본다. 좌표는 내려주지 않는다.
  router.get('/admin/field-check/location-exceptions', requireRole(...writeRoles), async (req: any, res: any) => {
    const daysRaw = Number(req.query?.days);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.floor(daysRaw))) : 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const rows: any[] = await prisma.locationException.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const ids = [...new Set(rows.map((r) => r.userId as string))];
    const users: any[] = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(users.map((u) => [u.id as string, u.name as string]));
    const valid = rows.filter((r) => { const n = nameOf.get(r.userId) ?? ''; return n && !n.startsWith('SAMPLE_'); });
    const median = (arr: number[]): number | null => {
      if (!arr.length) return null;
      const a = [...arr].sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
    };
    const deviceOf = (r: any): string => (r.deviceModel || r.os || '알 수 없음');
    const perUser = new Map<string, any>();
    const perDevice = new Map<string, { count: number; users: Set<string> }>();
    const perConn = new Map<string, number>();
    for (const r of valid) {
      const name = nameOf.get(r.userId) as string;
      const u = perUser.get(r.userId) ?? { userName: name, count: 0, lastAt: r.createdAt, devices: new Set<string>(), osList: new Set<string>(), browsers: new Set<string>(), connections: new Set<string>(), acc: [] as number[], dist: [] as number[] };
      u.count += 1;
      if (r.createdAt > u.lastAt) u.lastAt = r.createdAt;
      u.devices.add(deviceOf(r));
      if (r.os) u.osList.add(`${r.os}${r.osVersion ? ' ' + r.osVersion : ''}`);
      if (r.browser) u.browsers.add(r.browser);
      if (r.connectionType) u.connections.add(r.connectionType);
      if (typeof r.accuracyMeters === 'number') u.acc.push(r.accuracyMeters);
      if (typeof r.distanceMeters === 'number') u.dist.push(r.distanceMeters);
      perUser.set(r.userId, u);
      const dk = deviceOf(r);
      const d = perDevice.get(dk) ?? { count: 0, users: new Set<string>() };
      d.count += 1; d.users.add(r.userId); perDevice.set(dk, d);
      const ck = r.connectionType || '알 수 없음';
      perConn.set(ck, (perConn.get(ck) ?? 0) + 1);
    }
    const data = {
      days,
      total: valid.length,
      userCount: perUser.size,
      byDevice: [...perDevice.entries()].map(([device, v]) => ({ device, count: v.count, userCount: v.users.size })).sort((a, b) => b.count - a.count),
      byConnection: [...perConn.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      users: [...perUser.values()].map((u) => ({
        userName: u.userName, count: u.count, lastAt: u.lastAt,
        devices: [...u.devices], osList: [...u.osList], browsers: [...u.browsers], connections: [...u.connections],
        medianAccuracyMeters: median(u.acc), medianDistanceMeters: median(u.dist),
      })).sort((a, b) => b.count - a.count),
      recent: valid.slice(0, 100).map((r) => ({
        at: r.createdAt, userName: nameOf.get(r.userId) as string, status: r.status, clientName: r.clientName ?? '',
        distanceMeters: r.distanceMeters ?? null, accuracyMeters: r.accuracyMeters ?? null, address: r.address ?? '', reason: r.reason,
        device: deviceOf(r), os: `${r.os ?? ''}${r.osVersion ? ' ' + r.osVersion : ''}`.trim(), browser: r.browser ?? '',
        connection: r.connectionType ?? '', captureStatus: r.captureStatus ?? '',
      })),
    };
    await recordAuditLog({ actorUserId: req.authUser?.userId ?? null, actionType: 'LOCATION_DETAIL_VIEW', targetType: 'location_exceptions', afterValue: { days, total: data.total } });
    return res.json({ success: true, data });
  });

  router.get('/admin/field-check/location-failures', requireRole(...writeRoles), async (req: any, res: any) => {
    const daysRaw = Number(req.query?.days);
    const days = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, Math.floor(daysRaw))) : 7;
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await prisma.auditLog.findMany({
      where: { targetType: LOCATION_FAILURE_AUDIT_TARGET, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 3000,
      select: { actorUserId: true, afterValue: true, createdAt: true },
    });
    const actorIds = [...new Set((rows as any[]).map((r) => r.actorUserId).filter((x: any): x is string => !!x))];
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const actorName = new Map((actors as any[]).map((u) => [u.id as string, u.name as string]));
    const events: FailureEvent[] = [];
    for (const r of rows as any[]) {
      const v = (r.afterValue ?? {}) as any;
      const name = actorName.get(r.actorUserId) ?? '';
      if (!r.actorUserId || !name || name.startsWith('SAMPLE_')) continue;
      if (v.endpoint !== 'CLOCK_IN' && v.endpoint !== 'STATUS') continue;
      events.push({
        at: r.createdAt, userId: r.actorUserId, userName: name,
        endpoint: v.endpoint as FailureEndpoint, code: String(v.code ?? ''), status: typeof v.status === 'string' ? v.status : null,
        accuracyMeters: typeof v.accuracyMeters === 'number' ? v.accuracyMeters : null, hasLocation: Boolean(v.hasLocation),
        locationStatus: typeof v.locationStatus === 'string' ? v.locationStatus : null,
        device: ['PC', 'MOBILE', 'UNKNOWN'].includes(v.device) ? v.device : classifyDevice(null),
      });
    }
    const summary = summarizeLocationFailures(events);
    await recordAuditLog({ actorUserId: req.authUser?.userId ?? null, actionType: 'LOCATION_DETAIL_VIEW', targetType: 'location_failures', afterValue: { days, total: summary.total } });
    return res.json({ success: true, data: { days, ...summary, capped: rows.length >= 3000 } });
  });

  /**
   * 2026-10-15: "업무일지 점검" — 직원들이 일일업무일지를 잘 쓰는지(작성률), 성의 있게 쓰는지(내용 품질),
   * 고객사 작업 기록(공수)과 맞는지, 고객사별 집계 등 데이터로 쓸 수 있는지를 한 번에 보여준다(계산은 work-log-quality.ts).
   * 일지 본문(이슈·작업내용)을 일부 보여주므로 관리자(HR_ADMIN/SYSTEM_ADMIN)만 조회한다. SAMPLE_ 계정·퇴직자는 제외.
   * 작성률 분모는 "직접 퇴근까지 마친 날"(다우오피스 동기화분 제외 — attendance-gaps와 같은 기준)이다.
   */
  router.get('/admin/field-check/work-log-quality', requireRole(...writeRoles), async (req: any, res: any) => {
    const today = todayDateOnly();
    const defaultFrom = ymd(new Date(today.getTime() - 13 * 86_400_000));
    const range = parseRange(req.query, defaultFrom);
    if (!range) return badRange(res);
    const userFilter = { employmentStatus: 'ACTIVE' as const, ...NOT_SAMPLE_USER };
    const LIMIT = 12000;
    const dateRange = { gte: range.from, lte: range.to };

    const [logRows, attRows, effortRows, clientRows] = await Promise.all([
      prisma.dailyWorkLog.findMany({
        where: { workDate: dateRange, user: userFilter },
        take: LIMIT,
        select: {
          userId: true, workDate: true, formType: true, visitedClients: true, workContent: true, issues: true, tomorrowPlan: true, actualEffortMinutes: true,
          user: { select: { name: true, department: { select: { name: true } } } },
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { workDate: dateRange, clockInAt: { not: null }, dataSource: 'MANUAL', user: userFilter },
        take: LIMIT,
        select: { userId: true, workDate: true, clockOutAt: true, user: { select: { name: true, department: { select: { name: true } } } } },
      }),
      prisma.effortLog.findMany({
        where: { workDate: dateRange, user: userFilter },
        take: LIMIT * 2,
        select: { userId: true, workDate: true, clientName: true, actualMinutes: true, minutes: true },
      }),
      prisma.client.findMany({ select: { name: true } }),
    ]);

    const logs: QualityLogInput[] = (logRows as any[]).map((l) => ({
      userId: l.userId, userName: l.user?.name ?? '', departmentName: l.user?.department?.name ?? null, dateKey: ymd(l.workDate),
      formType: l.formType === 'DETAILED' ? 'DETAILED' : 'SIMPLE', visitedClients: l.visitedClients ?? null, workContent: l.workContent ?? null,
      issues: l.issues ?? '', tomorrowPlan: l.tomorrowPlan ?? '', actualEffortMinutes: typeof l.actualEffortMinutes === 'number' ? l.actualEffortMinutes : null,
    }));
    const attendance: QualityAttendanceInput[] = (attRows as any[]).map((a) => ({
      userId: a.userId, userName: a.user?.name ?? '', departmentName: a.user?.department?.name ?? null, dateKey: ymd(a.workDate), completed: a.clockOutAt != null,
    }));
    const efforts: QualityEffortInput[] = (effortRows as any[]).map((e) => ({
      userId: e.userId, dateKey: ymd(e.workDate), clientName: e.clientName ?? '', minutes: e.actualMinutes ?? e.minutes ?? 0,
    }));
    const summary = analyzeWorkLogs(logs, attendance, efforts, (clientRows as any[]).map((c) => c.name as string));
    return res.json({
      success: true,
      data: {
        from: ymd(range.from), to: ymd(range.to), ...summary,
        capped: logRows.length >= LIMIT || attRows.length >= LIMIT || effortRows.length >= LIMIT * 2,
      },
    });
  });
}
