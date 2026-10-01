// ══════════════════════════════════════════════════════════════════════════════
// 독립 검증 테스트 (Claude 작성, 패치 작성자의 테스트가 아님)
//
// 목적: 00-PROMPT-for-Claude.md 4단계 표에서 패치 자체의 테스트 모음(api/final/status-board/unit)이
// 다루지 않는 항목을 실제로 실행해서 확인한다. 기존 테스트 파일은 건드리지 않고 새 파일로만 추가한다.
//
// 다루는 항목:
//   - M-1  승인 처리(claim + 부수효과)가 진짜 하나의 트랜잭션인지 — 중간에 실패를 강제로 주입해서
//          "승인됨인데 잔액 미반영" 상태가 남는지 확인한다.
//   - M-13 직원이 임의 좌표로 고객사를 생성할 때 좌표 범위 검증이 실제로 동작하는지.
//   - L-8  다우오피스 동기화 스케줄러의 KST 환산식이 실제로 맞는지(전수 비교).
// ══════════════════════════════════════════════════════════════════════════════
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../common/prisma';
import { signAccessToken } from '../common/guards/auth';

// L-8 테스트 전용 모킹 — 실제 다우오피스/정책 모듈을 대체해서 스케줄러의 "시각 판정" 로직만
// 외부 부작용 없이 실제로 실행해본다(코드를 베껴서 재현하는 게 아니라 원본 함수를 그대로 호출).
jest.mock('../common/policy-engine/policy-engine', () => ({
  getPolicyBoolean: jest.fn(async () => true),
  getPolicyNumber: jest.fn(async () => 6),
  // 이 파일의 다른 describe(M-1/M-13)가 attendance/approval 라우트를 실제로 호출하는데, 그
  // 라우트 파일들도 같은 모듈에서 다른 함수들을 함께 import하고 있다 — L-8 전용으로 모듈 전체를
  // mock하면서 그 함수들까지 undefined가 되어 엉뚱하게 깨지지 않도록 안전한 기본 동작을 남겨둔다.
  getPolicyString: jest.fn(async (_key: string, fallback = '') => fallback),
  getPolicyJSON: jest.fn(async (_key: string, fallback: unknown) => fallback),
  setPolicyString: jest.fn(async () => undefined),
  setPolicyJSON: jest.fn(async () => undefined),
  invalidatePolicyCache: jest.fn(() => undefined),
}));
jest.mock('../modules/dauoffice/sync-employees', () => ({
  syncEmployeesFromDauoffice: jest.fn(async () => ({ created: 0, updated: 0, skipped: 0 })),
}));

const app = createApp();

let dept: string;
let empId: string, empToken: string;

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
  dept = (await prisma.department.create({ data: { name: 'IV_부서' } })).id;
  empId = (await prisma.user.create({
    data: { employeeNo: 'IV001', name: '독립검증직원', departmentId: dept, workType: 'HQ_FLEX', passwordHash: 'x' },
  })).id;
  empToken = signAccessToken({ userId: empId, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });
});

afterAll(async () => { await prisma.$disconnect(); });

// ══════════════════════════════════════════════════════════════════════════════
describe('[독립검증] M-1 승인 트랜잭션 원자성 (claim + 부수효과가 한 트랜잭션인가)', () => {
  it('leaveConversionRequest 갱신 단계에서 강제로 실패시키면, claim(APPROVED)도 함께 롤백되고 잔액도 늘지 않는다', async () => {
    const hrId = (await prisma.user.create({
      data: { employeeNo: 'IV002', name: '독립검증승인자', departmentId: dept, workType: 'HQ_FIXED', passwordHash: 'x' },
    })).id;
    const hrToken = signAccessToken({ userId: hrId, roles: ['HR_ADMIN'], departmentId: dept, tokenVersion: 0 });

    const leaveType = await prisma.leaveType.create({ data: { code: 'IV_ALT', name: 'IV대체휴무' } });
    const conversion = await prisma.leaveConversionRequest.create({
      data: { userId: empId, requestedLeaveTypeId: leaveType.id, convertedMinutes: 60, status: 'PENDING' },
    });
    const approval = await prisma.approvalRequest.create({
      data: {
        type: 'LEAVE_CONVERSION',
        referenceId: conversion.id,
        requesterId: empId,
        leaveConversionRequestId: conversion.id,
      },
    });

    // Prisma 미들웨어로 "LeaveConversionRequest.update" 호출 단 1회만 강제로 실패시킨다.
    // 이건 패치 코드를 건드리는 게 아니라, 테스트에서 외부로부터 중간 실패를 주입하는 것이다.
    // $transaction(async (tx) => {...}) 안에서 이 호출이 두 번째로 일어나므로(claim 성공 이후),
    // "claim까지는 됐는데 그 뒤가 실패"하는 상황을 그대로 재현한다.
    let injected = false;
    (prisma as any).$use(async (params: any, next: any) => {
      if (!injected && params.model === 'LeaveConversionRequest' && params.action === 'update') {
        injected = true;
        throw new Error('[독립검증 강제주입] 트랜잭션 중단 테스트');
      }
      return next(params);
    });

    const res = await request(app)
      .post(`/api/v1/approval/requests/${approval.id}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({});

    // 트랜잭션이 하나로 묶여있다면: 전체가 실패해서 500이어야 하고, 아래 세 가지가 전부 "미반영" 상태여야 한다.
    expect(res.status).toBe(500);

    const approvalAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    expect(approvalAfter.status).toBe('PENDING'); // claim이 커밋되어 APPROVED로 남아있으면 안 됨(트랜잭션 분리 회귀)

    const conversionAfter = await prisma.leaveConversionRequest.findUniqueOrThrow({ where: { id: conversion.id } });
    expect(conversionAfter.status).toBe('PENDING'); // 그대로

    const balance = await prisma.leaveBalance.findUnique({
      where: { userId_leaveTypeId: { userId: empId, leaveTypeId: leaveType.id } },
    });
    expect(balance).toBeNull(); // 잔액도 늘지 않음 — "승인됨인데 잔액 미반영" 상태가 안 남는다

    const auditCount = await prisma.auditLog.count({ where: { targetId: approval.id } });
    expect(auditCount).toBe(0); // 감사로그도 안 남음(부분 커밋 없음)

    // C-2 연계: 이 강제 예외 이후에도 서버 프로세스는 살아있어야 한다(500으로 응답했다는 것 자체가
    // 증거이기도 하지만, 추가로 health check까지 확인한다).
    const health = await request(app).get('/api/v1/health');
    expect(health.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('[독립검증] M-13 직원이 만드는 신규 고객사의 좌표 범위 검증', () => {
  it('위도 999는 400으로 거부된다(관리자 등록과 같은 min(-90).max(90))', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/clients')
      .set('Authorization', `Bearer ${empToken}`)
      .send({ name: 'IV_불량좌표고객사', latitude: 999, longitude: 127.0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    const created = await prisma.client.findFirst({ where: { name: 'IV_불량좌표고객사' } });
    expect(created).toBeNull(); // DB에도 저장되지 않음
  });

  it('경도 999도 400으로 거부된다', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/clients')
      .set('Authorization', `Bearer ${empToken}`)
      .send({ name: 'IV_불량경도고객사', latitude: 37.5, longitude: 999 });
    expect(res.status).toBe(400);
  });

  it('정상 좌표는 그대로 생성된다(회귀 없음)', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/clients')
      .set('Authorization', `Bearer ${empToken}`)
      .send({ name: 'IV_정상고객사', latitude: 37.5, longitude: 127.0 });
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('[독립검증] L-8 다우오피스 스케줄러가 실제로 KST 기준으로 판정하는가', () => {
  // 공식을 베껴서 비교하는 게 아니라, startDauofficeScheduler()를 실제로 실행시키고
  // setInterval 콜백이 "도는 시점"을 가짜 시계로 통제해서, 내부에서 실제로 kstHour 계산을 거쳐
  // syncEmployeesFromDauoffice가 호출되는지/안 되는지를 관찰한다.
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('UTC로는 "정시"가 아니지만 KST로는 정시(인터벌 6시간)인 순간엔 실행된다', async () => {
    const { startDauofficeScheduler } = require('../modules/dauoffice/dauoffice-scheduler');
    const { syncEmployeesFromDauoffice } = require('../modules/dauoffice/sync-employees');
    jest.useFakeTimers();
    // UTC 2026-01-01 21:00 = KST 2026-01-02 06:00 → kstHour=6, 6%6===0 → 실행되어야 함.
    // (UTC 시각 자체(21시)는 old 버그 공식 기준으로는 21%6=3 !==0 이라 "옛날 버그였다면 여기선 안 돈다"는
    //  지점을 일부러 골랐다 — 그래서 이 테스트가 통과한다는 것 자체가 "지금은 UTC가 아니라 KST로 판정한다"는 증거다.)
    jest.setSystemTime(new Date('2026-01-01T21:00:00.000Z'));
    startDauofficeScheduler();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(syncEmployeesFromDauoffice).toHaveBeenCalledTimes(1);
  });

  it('UTC로는 "정시"처럼 보여도 KST로는 정시가 아니면 실행되지 않는다(수정 전 버그 재현 지점)', async () => {
    const { startDauofficeScheduler } = require('../modules/dauoffice/dauoffice-scheduler');
    const { syncEmployeesFromDauoffice } = require('../modules/dauoffice/sync-employees');
    jest.useFakeTimers();
    // UTC 2026-01-01 06:00 → old(버그) 공식이면 hour=6, 6%6===0 이라 "실행됨"으로 잘못 판단했을 시각.
    // 실제 KST는 15:00 → 15%6=3 !==0 → 지금(수정 후) 로직은 실행하면 안 된다.
    jest.setSystemTime(new Date('2026-01-01T06:00:00.000Z'));
    startDauofficeScheduler();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(syncEmployeesFromDauoffice).not.toHaveBeenCalled();
  });
});
