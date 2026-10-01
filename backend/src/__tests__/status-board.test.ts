import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../common/prisma';
import { signAccessToken } from '../common/guards/auth';
import { todayDateOnly, realDayWindow, PROVISIONAL_HQ_NOTE } from '../common/attendance-helpers';
import { buildStatusBoard } from '../modules/dashboard/dashboard.routes';
import { buildStatusBoardLegacy } from './fixtures/legacy-status-board';

/**
 * M-5 검증: 일괄조회로 재작성한 buildStatusBoard가 기존(사용자별 N+1) 구현과
 * "모든 필드가 완전히 같은 결과"를 내는지, 의도적으로 까다로운 경우를 섞은 무작위 데이터로 비교한다.
 * 그리고 실제로 DB 쿼리 수가 얼마나 줄었는지 Prisma 쿼리 이벤트로 직접 센다.
 */

// 결정적 난수(같은 시드면 항상 같은 데이터 — 실패 재현 가능)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const STATUSES = ['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK', 'NIGHT_WORK', 'MOVING', 'ON_LEAVE', 'RESIDENT_ONSITE', 'BUSINESS_TRIP'] as const;
const CAPTURE = [null, 'OK', 'NO_CONSENT', 'PERMISSION_DENIED', 'TIMEOUT', 'UNSUPPORTED'] as const;

const app = createApp();
let hrToken = '';
const USER_COUNT = 120;
const workDate = todayDateOnly();
const pastDate = new Date(Date.UTC(2026, 8, 15));

let seedClientId = '';
async function seed(date: Date, r: () => number, prefix: string) {
  const { start, end } = realDayWindow(date);
  const span = end.getTime() - start.getTime();
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
  const users = await prisma.user.findMany({ where: { name: { startsWith: 'SB_' } } });

  for (const u of users) {
    const kind = r();
    if (kind < 0.12) continue; // 12%: 그날 아무 기록 없음

    // 상태 로그 0~6건
    const n = Math.floor(r() * 7);
    for (let i = 0; i < n; i++) {
      const status = pick(STATUSES);
      const locMatch = r() < 0.33 ? true : r() < 0.5 ? false : null;
      await prisma.statusChangeLog.create({
        data: {
          userId: u.id, status, source: 'WEB',
          changedAt: new Date(start.getTime() + Math.floor(r() * span)),
          note: r() < 0.4 ? null : r() < 0.15 ? PROVISIONAL_HQ_NOTE : `${prefix}메모${i}`,
          siteType: r() < 0.2 ? 'REMOTE' : r() < 0.5 ? 'ONSITE' : null,
          locationMatch: locMatch,
          locationDistanceMeters: locMatch === null ? null : Math.floor(r() * 5000),
          locationAccuracyMeters: r() < 0.5 ? null : Math.floor(r() * 300),
          locationCaptureStatus: pick(CAPTURE),
          mismatchLatitude: locMatch === false ? 37 + r() : null,
          mismatchLongitude: locMatch === false ? 127 + r() : null,
        },
      });
    }
    // 도착체크 0~3건
    const c = Math.floor(r() * 4);
    for (let i = 0; i < c; i++) {
      const t = new Date(start.getTime() + Math.floor(r() * span));
      await prisma.residentCheckin.create({
        data: {
          userId: u.id, clientId: seedClientId, checkinAt: t, lastConfirmedAt: t,
          locationMatch: r() < 0.5 ? true : r() < 0.5 ? false : null,
          locationDistanceMeters: Math.floor(r() * 3000),
          locationAccuracyMeters: Math.floor(r() * 200),
          mismatchLatitude: r() < 0.3 ? 37.1 : null, mismatchLongitude: r() < 0.3 ? 127.1 : null,
        },
      });
    }
    // 근태(퇴근 포함/미포함)
    if (r() < 0.8) {
      const clockIn = new Date(start.getTime() + Math.floor(r() * span * 0.5));
      await prisma.attendanceRecord.create({
        data: {
          userId: u.id, workDate: date, clockInAt: clockIn,
          clockOutAt: r() < 0.5 ? new Date(clockIn.getTime() + Math.floor(r() * 10 * 3600_000)) : null,
        },
      });
    }
    // 공수 0~3건 — 고객사명: 등록됨(좌표O)/등록됨(좌표X)/미등록/공백
    const e = Math.floor(r() * 4);
    for (let i = 0; i < e; i++) {
      await prisma.effortLog.create({
        data: {
          userId: u.id, workDate: date, projectName: '', workType: '기타',
          clientName: pick(['알파은행', '베타증권', '감마보험', '미등록고객사X', '  ', '알파']),
          startTime: new Date(start.getTime() + Math.floor(r() * span)),
        },
      });
    }
  }
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE audit_logs, alerts, daily_work_logs, admin_messages, push_subscriptions,
      approval_requests, attendance_correction_requests, leave_conversion_requests, night_work_sessions,
      effort_logs, business_trip_logs, break_sessions, attendance_records, status_change_logs,
      resident_checkins, dauoffice_leave_entries, night_work_mail_reports, leave_balances,
      pilot_feedback, pilot_group_members, pilot_groups, user_roles, users, clients, departments,
      policy_settings, leave_types, roles, dauoffice_tokens, dauoffice_department_overrides
    RESTART IDENTITY CASCADE;
  `);
  const hash = await bcrypt.hash('x', 4);
  const depts = await Promise.all(['SB_기술부', 'SB_영업부', 'SB_상주팀'].map((name) => prisma.department.create({ data: { name } })));
  await prisma.client.create({ data: { name: '알파은행', address: '-', latitude: 37.5, longitude: 127 } });
  await prisma.client.create({ data: { name: '베타증권', address: '-', latitude: null, longitude: null } });
  const assigned = await prisma.client.create({ data: { name: '감마보험', address: '-', latitude: 37.4, longitude: 127.1 } });
  seedClientId = assigned.id;

  const r = rng(20260930);
  for (let i = 0; i < USER_COUNT; i++) {
    await prisma.user.create({
      data: {
        employeeNo: `SB${String(i).padStart(3, '0')}`, name: `SB_직원${i}`, passwordHash: hash,
        departmentId: depts[i % 3].id, workType: i % 3 === 2 ? 'RESIDENT' : 'HQ_FLEX',
        assignedClientId: i % 3 === 2 ? assigned.id : null,
        includedInBoard: i % 17 !== 0, // 일부는 표시대상 제외
        locationConsentAt: r() < 0.8 ? new Date() : null,
        privacyConsentAt: r() < 0.9 ? new Date() : null,
      },
    });
  }
  // SAMPLE_ 계정은 양쪽 모두 제외되어야 한다
  await prisma.user.create({ data: { employeeNo: 'SAMPLE_X', name: 'SAMPLE_제외', passwordHash: hash, departmentId: depts[0].id, workType: 'HQ_FLEX', includedInBoard: true } });

  await seed(workDate, rng(1), '오늘');

  // 무작위 데이터만으로는 드물게 빠질 수 있는 분기를 확정적으로 1명씩 만든다(비교가 모든 분기를 타도록).
  // (a) CLIENT_NO_COORDS: 좌표 없는 고객사(베타증권)로 고객사작업, 위치 미일치, 현장
  {
    const { start } = realDayWindow(workDate);
    const u = await prisma.user.create({ data: { employeeNo: 'SB_FIX1', name: 'SB_고정_좌표없음', passwordHash: hash, departmentId: depts[0].id, workType: 'HQ_FLEX', includedInBoard: true } });
    await prisma.statusChangeLog.create({ data: { userId: u.id, status: 'CLIENT_WORK', source: 'WEB', changedAt: new Date(start.getTime() + 3600_000), siteType: 'ONSITE', locationMatch: null } });
    await prisma.effortLog.create({ data: { userId: u.id, workDate, clientName: '베타증권', projectName: '', workType: '기타', startTime: new Date(start.getTime() + 3600_000) } });
    // (b) 마지막 로그는 위치 불일치지만 그날 앞서 위치 확인 성공 이력이 있음 → 확인됨으로 보정되는 분기
    const v = await prisma.user.create({ data: { employeeNo: 'SB_FIX2', name: 'SB_고정_보정', passwordHash: hash, departmentId: depts[1].id, workType: 'HQ_FLEX', includedInBoard: true } });
    await prisma.statusChangeLog.create({ data: { userId: v.id, status: 'HQ_WORKING', source: 'WEB', changedAt: new Date(start.getTime() + 2 * 3600_000), locationMatch: true, locationDistanceMeters: 12, locationCaptureStatus: 'OK' } });
    await prisma.statusChangeLog.create({ data: { userId: v.id, status: 'CLIENT_MEETING', source: 'WEB', changedAt: new Date(start.getTime() + 5 * 3600_000), locationMatch: false, locationDistanceMeters: 4200, siteType: 'ONSITE', mismatchLatitude: 37.9, mismatchLongitude: 127.9 } });
    // (c) 퇴근 후 야간작업 등록 → "퇴근완료"로 덮지 않는 분기
    const w = await prisma.user.create({ data: { employeeNo: 'SB_FIX3', name: 'SB_고정_퇴근후야간', passwordHash: hash, departmentId: depts[2].id, workType: 'HQ_FLEX', includedInBoard: true } });
    await prisma.attendanceRecord.create({ data: { userId: w.id, workDate, clockInAt: new Date(start.getTime() + 6 * 3600_000), clockOutAt: new Date(start.getTime() + 15 * 3600_000) } });
    await prisma.statusChangeLog.create({ data: { userId: w.id, status: 'NIGHT_WORK', source: 'WEB', changedAt: new Date(start.getTime() + 19 * 3600_000) } });
  }
  await seed(pastDate, rng(2), '과거');

  const hr = await prisma.user.create({ data: { employeeNo: 'SB_HR', name: 'HR관리자', passwordHash: hash, departmentId: depts[0].id, workType: 'HQ_FIXED', includedInBoard: false } });
  hrToken = signAccessToken({ userId: hr.id, roles: ['HR_ADMIN'], departmentId: depts[0].id, tokenVersion: 0 });
}, 180000);

afterAll(async () => { await prisma.$disconnect(); });

const byUserId = (rows: { userId: string }[]) => [...rows].sort((a, b) => a.userId.localeCompare(b.userId));

describe('M-5 상황판 일괄조회 재작성 — 기존 구현과 결과 동일성', () => {
  it.each([
    ['오늘 · 관리자(좌표 포함)', () => workDate, true],
    ['오늘 · 팀장(좌표 제외)', () => workDate, false],
    ['과거 날짜 스냅샷 · 관리자', () => pastDate, true],
    ['기록이 전혀 없는 날짜', () => new Date(Date.UTC(2025, 0, 1)), true],
  ])('%s', async (_label, dateFn, coords) => {
    const d = (dateFn as () => Date)();
    const legacy = await buildStatusBoardLegacy(undefined, d, coords as boolean);
    const next = await buildStatusBoard(undefined, d, coords as boolean);
    expect(next.length).toBe(legacy.length);
    expect(byUserId(next)).toEqual(byUserId(legacy)); // 모든 필드 깊은 비교
  });

  it('특정 사용자만 지정해도 동일하다(부서/고객사별 상황판 경로)', async () => {
    const some = (await prisma.user.findMany({ where: { name: { startsWith: 'SB_직원' } }, take: 25 })).map((u) => u.id);
    const legacy = await buildStatusBoardLegacy(some, workDate, true);
    const next = await buildStatusBoard(some, workDate, true);
    expect(byUserId(next)).toEqual(byUserId(legacy));
  });

  it('의미있는 비교였는지 확인 — 데이터가 다양한 경우를 실제로 포함한다', async () => {
    const board = await buildStatusBoard(undefined, workDate, true);
    const has = (f: (r: (typeof board)[number]) => boolean) => board.some(f);
    expect(has((r) => r.status === null)).toBe(true);                         // 기록 없음
    expect(has((r) => r.clockedOut)).toBe(true);                              // 퇴근완료
    expect(has((r) => r.locationMatch === true)).toBe(true);
    expect(has((r) => r.locationMatch === false)).toBe(true);
    expect(has((r) => r.effortClientName !== null)).toBe(true);               // 공수 대체표시
    expect(has((r) => r.clientLocationDiagnosis === 'CLIENT_NO_COORDS')).toBe(true);
    expect(has((r) => r.clientLocationDiagnosis === 'NO_CLIENT_MATCH')).toBe(true);
    expect(has((r) => r.isProvisional)).toBe(true);
    expect(has((r) => r.mismatchLatitude != null)).toBe(true);
    // 고정 시나리오 (b): 마지막 로그는 불일치지만 그날 성공 이력으로 "확인됨" 보정
    const fixed = board.find((r) => r.name === 'SB_고정_보정')!;
    expect(fixed.status).toBe('CLIENT_MEETING');
    expect(fixed.locationMatch).toBe(true);
    expect(fixed.locationDistanceMeters).toBe(12);
    // 고정 시나리오 (c): 퇴근 후 야간작업은 퇴근완료로 덮지 않는다
    const night = board.find((r) => r.name === 'SB_고정_퇴근후야간')!;
    expect(night.status).toBe('NIGHT_WORK');
    expect(night.clockedOut).toBe(false);
    expect(board.every((r) => !r.name.startsWith('SAMPLE_'))).toBe(true);
  });
});

describe('M-5 쿼리 수 실측', () => {
  it('쿼리 수가 사용자 수에 비례하지 않는다 (N+1 제거)', async () => {
    const counter = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    let count = 0;
    (counter as unknown as { $on: (e: 'query', cb: (ev: Prisma.QueryEvent) => void) => void }).$on('query', () => { count += 1; });

    // 동일한 두 구현을 계측 클라이언트로 돌리기 위해 전역 prisma의 메서드를 잠시 위임한다.
    const g = prisma as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const k of ['user', 'statusChangeLog', 'residentCheckin', 'attendanceRecord', 'effortLog', 'client']) {
      saved[k] = g[k];
      g[k] = (counter as unknown as Record<string, unknown>)[k];
    }
    try {
      count = 0; await buildStatusBoardLegacy(undefined, workDate, true); const legacyQ = count;
      count = 0; await buildStatusBoard(undefined, workDate, true); const newQ = count;
      const users = (await buildStatusBoard(undefined, workDate, true)).length;
      // eslint-disable-next-line no-console
      console.log(`[M-5] 표시대상 ${users}명 — 기존 ${legacyQ}쿼리 → 신규 ${newQ}쿼리 (${(legacyQ / newQ).toFixed(1)}배 감소)`);
      expect(newQ).toBeLessThanOrEqual(5 + 6); // 일괄 5회 + 서로 다른 진단 고객사명 수(최대 6)
      expect(legacyQ).toBeGreaterThan(users * 3);
    } finally {
      for (const k of Object.keys(saved)) g[k] = saved[k];
      await counter.$disconnect();
    }
  });

  it('API 응답(/dashboard/company)도 정상이다', async () => {
    const res = await request(app).get('/api/v1/dashboard/company').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.employees.length).toBeGreaterThan(90);
    const total = Object.values(res.body.data.summary as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(res.body.data.employees.length);
  });
});

describe('M-3 잘림 플래그', () => {
  it('피드백이 상한(300)을 넘으면 X-Result-Truncated: true 이고 정확히 300건만 온다', async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { name: 'SB_직원1' } });
    const pg = await prisma.pilotGroup.create({ data: { name: 'SB_파일럿', startDate: new Date(), endDate: new Date() } });
    await prisma.pilotFeedback.createMany({
      data: Array.from({ length: 305 }, (_, i) => ({ pilotGroupId: pg.id, userId: u.id, category: 'OTHER' as const, content: `피드백${i}` })),
    });
    const res = await request(app).get('/api/v1/pilot/feedback').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-result-truncated']).toBe('true');
    expect(res.headers['x-result-limit']).toBe('300');
    expect(res.body.data.length).toBe(300);
  });

  it('상한 이하면 X-Result-Truncated: false', async () => {
    const res = await request(app).get('/api/v1/night-work-mail').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-result-truncated']).toBe('false');
  });

  it('메시지함 대화목록: 사용자별 최신 1건 + 안 읽은 답장 수가 정확하다', async () => {
    const [a, b] = await prisma.user.findMany({ where: { name: { in: ['SB_직원2', 'SB_직원3'] } }, orderBy: { name: 'asc' } });
    const t0 = Date.now() - 3600_000;
    await prisma.adminMessage.createMany({
      data: [
        { userId: a.id, message: 'a1', senderIsAdmin: true, sentByName: '관리자', createdAt: new Date(t0) },
        { userId: a.id, message: 'a2 답장', senderIsAdmin: false, sentByName: 'A', createdAt: new Date(t0 + 1000) },
        { userId: a.id, message: 'a3 답장', senderIsAdmin: false, sentByName: 'A', createdAt: new Date(t0 + 2000) },
        { userId: b.id, message: 'b1', senderIsAdmin: true, sentByName: '관리자', createdAt: new Date(t0 + 3000) },
        { userId: b.id, message: 'b2 읽은답장', senderIsAdmin: false, sentByName: 'B', createdAt: new Date(t0 + 500), readAt: new Date() },
      ],
    });
    const res = await request(app).get('/api/v1/messages/admin/conversations').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    const list = res.body.data as { userId: string; lastMessage: string; unreadCount: number; lastMessageFromAdmin: boolean }[];
    expect(list[0].userId).toBe(b.id);            // 최근 대화순
    expect(list[0].lastMessage).toBe('b1');
    expect(list[0].unreadCount).toBe(0);
    const ca = list.find((c) => c.userId === a.id)!;
    expect(ca.lastMessage).toBe('a3 답장');
    expect(ca.lastMessageFromAdmin).toBe(false);
    expect(ca.unreadCount).toBe(2);
  });

  it('알림: 전환된 야간근무가 100건 넘게 쌓여도 미전환 건이 누락되지 않는다', async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { name: 'SB_직원4' } });
    const lt = await prisma.leaveType.create({ data: { code: 'ALT_DAY_OFF', name: '대체휴무' } });
    const oldUnconverted = await prisma.nightWorkSession.create({
      data: { userId: u.id, startedAt: new Date(Date.now() - 90 * 86400_000), endedAt: new Date(Date.now() - 90 * 86400_000 + 3600_000), status: 'COMPLETED', workedMinutes: 60 },
    });
    for (let i = 0; i < 120; i++) {
      const s = await prisma.nightWorkSession.create({
        data: { userId: u.id, startedAt: new Date(Date.now() - i * 3600_000 - 7200_000), endedAt: new Date(Date.now() - i * 3600_000), status: 'COMPLETED', workedMinutes: 60 },
      });
      await prisma.leaveConversionRequest.create({ data: { userId: u.id, sourceNightWorkSessionId: s.id, requestedLeaveTypeId: lt.id, convertedMinutes: 60, status: 'APPROVED' } });
    }
    const res = await request(app).get('/api/v1/alerts').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    const hit = (res.body.data as { ruleCode: string; relatedId?: string }[])
      .filter((a) => a.ruleCode === 'NIGHT_WORK_NOT_CONVERTED').map((a) => a.relatedId);
    expect(hit).toContain(oldUnconverted.id); // 수정 전: 최신 100건이 전부 '전환됨'이라 이 건이 사라졌다
  });
});
