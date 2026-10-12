// DB 없이 prisma를 가짜로 바꿔 /attendance/status·/clock-in·/clock-out 이 새 규칙(담당자 필수, GPS 재측정, 위치 실패 사유,
// 자동 마무리, 퇴근 위치)을 실제 라우트에서 지키는지 확인하는 연결 테스트. 규칙 함수 자체는 field-rules.test.ts 에서 검증한다.
const policy: Record<string, any> = {};
jest.mock('../common/policy-engine/policy-engine', () => ({
  getPolicyNumber: async (k: string, f: number) => (k in policy ? Number(policy[k]) : f),
  getPolicyString: async (k: string, f: string) => (k in policy ? String(policy[k]) : f),
  getPolicyBoolean: async (k: string, f: boolean) => (k in policy ? Boolean(policy[k]) : f),
  getPolicyJSON: async (k: string, f: any) => (k in policy ? policy[k] : f),
}));

// 모든 모델 메서드를 jest.fn 으로 자동 생성한다(findMany=[], count=0, 그 외=null 기본값).
const fns: Record<string, jest.Mock> = {};
function model(name: string) {
  return new Proxy({}, {
    get(_t, method: string) {
      const key = `${name}.${method}`;
      if (!fns[key]) {
        fns[key] = jest.fn(async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null));
      }
      return fns[key];
    },
  });
}
const mockPrisma: any = new Proxy({ $transaction: async (fn: any) => fn(mockPrisma) }, {
  get(t: any, name: string) { return name in t ? t[name] : model(name); },
});
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../common/guards/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.authUser = { userId: 'u1', roles: ['EMPLOYEE'] }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../common/audit', () => ({ recordAuditLog: jest.fn(async () => undefined) }));
jest.mock('../modules/projects/project-autolink', () => ({ resolveAutoProject: jest.fn(async () => null) }));
jest.mock('../modules/daily-work-log/daily-work-log.routes', () => {
  const actual = jest.requireActual('../modules/daily-work-log/daily-work-log.routes');
  return { ...actual, upsertDailyWorkLog: jest.fn(async () => ({})), computeUnloggedGapMinutes: jest.fn(async () => null) };
});

import express from 'express';
import request from 'supertest';
import { attendanceRouter } from '../modules/attendance/attendance.routes';

const app = express();
app.use(express.json());
app.use('/attendance', attendanceRouter);

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT = { id: CLIENT_ID, name: '코스콤', latitude: 37.5, longitude: 127.0 };
const NEAR = { lat: 37.5001, lng: 127.0001 };
const FAR = { lat: 37.9, lng: 127.5 };
const f = (k: string) => fns[k];

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'], now: new Date('2026-10-13T02:00:00Z') }); // 화요일 11:00 KST
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  Object.keys(policy).forEach((k) => delete policy[k]);
  Object.values(fns).forEach((m) => { m.mockReset(); });
  // 기본 동작 복구
  for (const [key, m] of Object.entries(fns)) {
    const method = key.split('.')[1];
    m.mockImplementation(async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null));
  }
  // 이미 출근한 상태
  f('attendanceRecord.findUnique') ?? (fns['attendanceRecord.findUnique'] = jest.fn());
});

function setup(overrides: Record<string, any> = {}) {
  const get = (k: string) => fns[k] ?? (fns[k] = jest.fn(async () => null));
  get('attendanceRecord.findUnique').mockResolvedValue({ id: 'r1', userId: 'u1', clockInAt: new Date('2026-10-13T00:00:00Z'), clockOutAt: null, breakSessions: [] });
  get('client.findFirst').mockResolvedValue(CLIENT);
  get('client.findUnique').mockResolvedValue(CLIENT);
  get('statusChangeLog.create').mockImplementation(async ({ data }: any) => ({ id: 'log1', ...data }));
  get('effortLog.create').mockImplementation(async ({ data }: any) => ({ id: 'e-new', ...data }));
  get('clientContact.upsert').mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', name: '김대리', phone: null });
  for (const [k, v] of Object.entries(overrides)) get(k).mockResolvedValue(v);
}

const baseEffort = { clientName: '코스콤', clientId: CLIENT_ID, workType: '정기점검', startTime: '10:00' };
const post = (body: any) => request(app).post('/attendance/status').send(body);

describe('POST /attendance/status — 고객사 작업·미팅 필수 입력', () => {
  it('도착 즉시등록(내용·담당자 없음)은 통과한다', async () => {
    setup();
    const r = await post({ status: 'CLIENT_WORK', siteType: 'ONSITE', location: NEAR, accuracyMeters: 30, locationStatus: 'OK', effort: baseEffort });
    expect(r.status).toBe(200);
    expect(f('effortLog.create')).toHaveBeenCalled();
  });
  it('작업내용이 있는데 담당자가 없으면 CONTACT_REQUIRED(아무것도 저장되지 않음)', async () => {
    setup();
    const r = await post({ status: 'CLIENT_WORK', siteType: 'ONSITE', location: NEAR, effort: { ...baseEffort, description: '점검', endTime: '12:00' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CONTACT_REQUIRED');
    expect(f('statusChangeLog.create')).not.toHaveBeenCalled();
    expect(f('effortLog.create')).not.toHaveBeenCalled();
  });
  it('완료시간만 있고 내용이 없으면 DESCRIPTION_REQUIRED', async () => {
    setup();
    const r = await post({ status: 'CLIENT_MEETING', siteType: 'ONSITE', location: NEAR, effort: { ...baseEffort, endTime: '12:00', contactName: '김대리' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('DESCRIPTION_REQUIRED');
  });
  it('담당자를 이름으로 주면 고객사 아래에 저장되고 공수 기록에 스냅샷이 남는다', async () => {
    setup();
    const r = await post({ status: 'CLIENT_WORK', siteType: 'ONSITE', location: NEAR, accuracyMeters: 30, effort: { ...baseEffort, description: '점검', endTime: '12:00', contactName: '김대리', contactPhone: '010-1' } });
    expect(r.status).toBe(200);
    expect(f('clientContact.upsert')).toHaveBeenCalled();
    const created = f('effortLog.create').mock.calls[0][0].data;
    expect(created.contactName).toBe('김대리');
    expect(created.contactId).toBe('22222222-2222-4222-8222-222222222222');
  });
  it('정책값으로 담당자 필수를 끄면(0) 담당자 없이도 저장된다', async () => {
    setup();
    policy.ENFORCE_CLIENT_CONTACT = 0;
    const r = await post({ status: 'CLIENT_WORK', siteType: 'ONSITE', location: NEAR, accuracyMeters: 30, effort: { ...baseEffort, description: '점검', endTime: '12:00' } });
    expect(r.status).toBe(200);
  });
});

describe('POST /attendance/status — GPS 오차 1km 이상', () => {
  const body = (extra: any = {}) => ({ status: 'CLIENT_WORK', siteType: 'ONSITE', location: FAR, accuracyMeters: 2800, locationStatus: 'OK', effort: baseEffort, ...extra });
  it('처음엔 GPS_ACCURACY_LOW 로 막고 아무것도 저장하지 않는다', async () => {
    setup();
    const r = await post(body());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    expect(f('statusChangeLog.create')).not.toHaveBeenCalled();
  });
  it('건물 밖 재측정 후(outdoorRecheckCount≥1)에도 부정확하면 등록은 되고 관리자 확인 표식이 남는다', async () => {
    setup();
    const r = await post(body({ outdoorRecheckCount: 1 }));
    expect(r.status).toBe(200);
    expect(r.body.data.locationMismatchException).toBe(true);
    const data = f('statusChangeLog.create').mock.calls[0][0].data;
    expect(data.note).toContain('GPS 정확도 낮음');
    expect(data.locationMatch).toBe(false);
  });
  it('정책값 GPS_LOW_ACCURACY_RECHECK=0 이면 예전처럼 바로 통과', async () => {
    setup();
    policy.GPS_LOW_ACCURACY_RECHECK = 0;
    const r = await post(body());
    expect(r.status).toBe(200);
  });
  it('오차가 작은데 멀리 있으면 기존대로 LOCATION_MISMATCH_BLOCKED', async () => {
    setup();
    const r = await post(body({ accuracyMeters: 50 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_MISMATCH_BLOCKED');
  });
});

describe('POST /attendance/status — 위치를 못 구한 경우', () => {
  const body = (extra: any = {}) => ({ status: 'CLIENT_WORK', siteType: 'ONSITE', locationStatus: 'PERMISSION_DENIED', effort: baseEffort, ...extra });
  it('기본값(봐주기 0회): 사유 없이는 LOCATION_REQUIRED', async () => {
    setup();
    const r = await post(body());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_REQUIRED');
  });
  it('5자 이상 사유를 적으면 등록되고 상태 메모에 사유가 남는다', async () => {
    setup();
    const r = await post(body({ locationFailureReason: '지하 기계실이라 GPS 불가' }));
    expect(r.status).toBe(200);
    expect(f('statusChangeLog.create').mock.calls[0][0].data.note).toContain('위치 확인 불가');
  });
  it('정책 LOCATION_FAILURE_GRACE_COUNT=1 이면 오늘 첫 실패는 사유 없이 허용', async () => {
    setup();
    policy.LOCATION_FAILURE_GRACE_COUNT = 1;
    const r = await post(body());
    expect(r.status).toBe(200);
  });
  it('오늘 첫 출근(첫 상태 등록)은 사유로 대체할 수 없다', async () => {
    setup({ 'attendanceRecord.findUnique': null });
    const r = await post(body({ locationFailureReason: '지하 기계실이라 GPS 불가' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_REQUIRED_FOR_WORK_START');
  });
});

describe('POST /attendance/status — 이전 진행중 작업 자동 마무리', () => {
  it('다른 상태로 바꾸면 열려 있던 고객사 작업이 지금 시각으로 닫히고 closedBy 가 남는다', async () => {
    setup();
    const open = { id: 'old1', userId: 'u1', sourceStatus: 'CLIENT_WORK', clientName: '코스콤', startTime: new Date('2026-10-13T00:30:00Z'), endTime: null };
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockResolvedValue([open]);
    fns['effortLog.update'] = fns['effortLog.update'] ?? jest.fn();
    fns['effortLog.update'].mockImplementation(async ({ data }: any) => ({ id: 'old1', ...data }));
    const r = await post({ status: 'MOVING', note: '코스콤 → 본사' });
    expect(r.status).toBe(200);
    const upd = f('effortLog.update').mock.calls[0][0];
    expect(upd.where.id).toBe('old1');
    expect(upd.data.closedBy).toBe('AUTO_STATUS_CHANGE');
    expect(upd.data.endTime.toISOString()).toBe('2026-10-13T02:00:00.000Z');
    expect(upd.data.minutes).toBe(90);
  });
  it('같은 고객사의 새 기록으로 대체되는 경우엔 시작시각에 닫아 시간이 이중으로 잡히지 않는다(SUPERSEDED)', async () => {
    setup();
    const open = { id: 'old1', userId: 'u1', sourceStatus: 'CLIENT_WORK', clientName: '코스콤', startTime: new Date('2026-10-13T00:30:00Z'), endTime: null };
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockResolvedValue([open]);
    fns['effortLog.update'] = fns['effortLog.update'] ?? jest.fn();
    fns['effortLog.update'].mockImplementation(async ({ data }: any) => ({ id: 'old1', ...data }));
    const r = await post({ status: 'CLIENT_WORK', siteType: 'ONSITE', location: NEAR, accuracyMeters: 30, effort: { ...baseEffort, startTime: '09:30' } });
    expect(r.status).toBe(200);
    const upd = f('effortLog.update').mock.calls[0][0];
    expect(upd.data.closedBy).toBe('SUPERSEDED');
    expect(upd.data.minutes).toBe(0);
  });
  it('자동 마무리가 실패해도 상태 등록은 성공한다', async () => {
    setup();
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await post({ status: 'MOVING', note: 'x → y' });
    expect(r.status).toBe(200);
    spy.mockRestore();
  });
});

describe('POST /attendance/clock-out — 퇴근 위치와 자동 마무리', () => {
  const dwl = { issues: '특이사항 없음', tomorrowPlan: '내일 점검' };
  const policyHq = () => { policy.HQ_LATITUDE = '37.4'; policy.HQ_LONGITUDE = '127.1'; policy.MIN_HOURS_BEFORE_CLOCKOUT = 0; };
  function setupOut(lastStatus: any) {
    setup();
    fns['statusChangeLog.findFirst'] = fns['statusChangeLog.findFirst'] ?? jest.fn();
    fns['statusChangeLog.findFirst'].mockResolvedValue(lastStatus);
    fns['attendanceRecord.update'] = fns['attendanceRecord.update'] ?? jest.fn();
    fns['attendanceRecord.update'].mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
    fns['effortLog.findFirst'] = fns['effortLog.findFirst'] ?? jest.fn();
    fns['effortLog.findFirst'].mockResolvedValue({ clientName: '코스콤' });
  }
  const out = (body: any = {}) => request(app).post('/attendance/clock-out').send({ dailyWorkLog: dwl, ...body });

  it('본사근무로 퇴근하는데 위치도 사유도 없으면 LOCATION_REQUIRED_FOR_CLOCKOUT', async () => {
    policyHq();
    setupOut({ status: 'HQ_WORKING', siteType: null });
    const r = await out({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_REQUIRED_FOR_CLOCKOUT');
    expect(f('attendanceRecord.update')).not.toHaveBeenCalled();
  });
  it('위치를 못 구해도 사유(5자 이상)를 적으면 퇴근이 확정되고 사유가 남는다', async () => {
    policyHq();
    setupOut({ status: 'HQ_WORKING', siteType: null });
    const r = await out({ locationFailureReason: '휴대폰 GPS 고장' });
    expect(r.status).toBe(200);
    expect(f('attendanceRecord.update').mock.calls[0][0].data.clockOutLocationNote).toBe('휴대폰 GPS 고장');
  });
  it('본사 반경 안에서 퇴근하면 place=HQ, 일치=true 로 저장되고 좌표는 저장되지 않는다', async () => {
    policyHq();
    setupOut({ status: 'HQ_WORKING', siteType: null });
    const r = await out({ locationStatus: 'OK', location: { lat: 37.4001, lng: 127.1001 }, accuracyMeters: 20 });
    expect(r.status).toBe(200);
    const data = f('attendanceRecord.update').mock.calls[0][0].data;
    expect(data.clockOutPlace).toBe('HQ');
    expect(data.clockOutLocationMatch).toBe(true);
    expect(JSON.stringify(data)).not.toContain('37.4001');
  });
  it('좌표가 있으면 locationStatus 가 비어 있어도 위치 확인으로 인정한다(주소 변환만 실패한 경우)', async () => {
    policyHq();
    setupOut({ status: 'HQ_WORKING', siteType: null });
    const r = await out({ locationStatus: 'GEOCODE_FAILED', location: { lat: 37.4001, lng: 127.1001 }, accuracyMeters: 20 });
    expect(r.status).toBe(200);
    expect(f('attendanceRecord.update').mock.calls[0][0].data.clockOutPlace).toBe('HQ');
  });
  it('본사근무인데 멀리서 퇴근 → 퇴근은 확정, place=OTHER·일치=false 로 남는다(막지 않음)', async () => {
    policyHq();
    setupOut({ status: 'HQ_WORKING', siteType: null });
    const r = await out({ locationStatus: 'OK', location: FAR, accuracyMeters: 20 });
    expect(r.status).toBe(200);
    const data = f('attendanceRecord.update').mock.calls[0][0].data;
    expect(data.clockOutPlace).toBe('OTHER');
    expect(data.clockOutLocationMatch).toBe(false);
  });
  it('고객사 현장에서 퇴근하면 place=CLIENT, 열려 있던 작업은 퇴근 시각으로 닫힌다', async () => {
    policyHq();
    setupOut({ status: 'CLIENT_WORK', siteType: 'ONSITE' });
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockResolvedValue([{ id: 'o1', userId: 'u1', sourceStatus: 'CLIENT_WORK', clientName: '코스콤', startTime: new Date('2026-10-13T00:30:00Z'), endTime: null, lastSeenAt: null }]);
    fns['effortLog.update'] = fns['effortLog.update'] ?? jest.fn();
    fns['effortLog.update'].mockImplementation(async ({ data }: any) => ({ id: 'o1', ...data }));
    const r = await out({ locationStatus: 'OK', location: NEAR, accuracyMeters: 20 });
    expect(r.status).toBe(200);
    expect(f('attendanceRecord.update').mock.calls[0][0].data.clockOutPlace).toBe('CLIENT');
    const upd = f('effortLog.update').mock.calls[0][0].data;
    expect(upd.closedBy).toBe('AUTO_CLOCKOUT');
    expect(upd.endTime.toISOString()).toBe('2026-10-13T02:00:00.000Z');
  });
  it('고객사 작업이 열린 채 본사/다른 곳에서 퇴근하고 마지막 확인 후 30분이 지났으면 마지막 확인 시각으로 닫는다', async () => {
    policyHq();
    setupOut({ status: 'CLIENT_WORK', siteType: 'ONSITE' });
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockResolvedValue([{ id: 'o1', userId: 'u1', sourceStatus: 'CLIENT_WORK', clientName: '코스콤', startTime: new Date('2026-10-13T00:30:00Z'), endTime: null, lastSeenAt: new Date('2026-10-13T01:10:00Z') }]);
    fns['effortLog.update'] = fns['effortLog.update'] ?? jest.fn();
    fns['effortLog.update'].mockImplementation(async ({ data }: any) => ({ id: 'o1', ...data }));
    const r = await out({ locationStatus: 'OK', location: { lat: 37.4001, lng: 127.1001 }, accuracyMeters: 20 }); // 본사 근처
    expect(r.status).toBe(200);
    expect(f('attendanceRecord.update').mock.calls[0][0].data.clockOutPlace).toBe('HQ');
    expect(f('effortLog.update').mock.calls[0][0].data.endTime.toISOString()).toBe('2026-10-13T01:10:00.000Z');
  });
  it('자동 마무리가 실패해도 퇴근은 확정된다', async () => {
    policyHq();
    setupOut({ status: 'CLIENT_WORK', siteType: 'ONSITE' });
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await out({ locationStatus: 'OK', location: NEAR, accuracyMeters: 20 });
    expect(r.status).toBe(200);
    spy.mockRestore();
  });
});

describe('POST /attendance/clock-in — GPS 오차 1km 이상', () => {
  beforeEach(() => { policy.HQ_LATITUDE = '37.4'; policy.HQ_LONGITUDE = '127.1'; });
  const body = (extra: any = {}) => ({ location: FAR, accuracyMeters: 2800, ...extra });
  it('처음엔 GPS_ACCURACY_LOW, 재측정 후엔 출근이 확정된다(출근은 지켜짐)', async () => {
    setup({ 'attendanceRecord.findUnique': null });
    fns['attendanceRecord.create'] = fns['attendanceRecord.create'] ?? jest.fn();
    fns['attendanceRecord.create'].mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
    let r = await request(app).post('/attendance/clock-in').send(body());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    expect(f('attendanceRecord.create')).not.toHaveBeenCalled();
    r = await request(app).post('/attendance/clock-in').send(body({ outdoorRecheckCount: 1 }));
    expect(r.status).toBe(200);
    expect(f('attendanceRecord.create')).toHaveBeenCalled();
  });
});

describe('관리자 현장 기록 점검 — 과거 미종료 작업 추정', () => {
  const OPEN_ID = '44444444-4444-4444-8444-444444444444';
  const SLOW_ID = '55555555-5555-4555-8555-555555555555';
  const openRow = (id: string, startIso: string) => ({ id, userId: 'u2', workDate: new Date('2026-10-05T00:00:00Z'), clientName: '코스콤', workType: '점검', sourceStatus: 'CLIENT_WORK', startTime: new Date(startIso), description: null, user: { name: '홍길동' } });
  function setupOpen() {
    setup();
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockResolvedValue([openRow(OPEN_ID, '2026-10-05T01:00:00Z'), openRow(SLOW_ID, '2026-10-06T01:00:00Z')]);
    fns['statusChangeLog.findFirst'] = fns['statusChangeLog.findFirst'] ?? jest.fn();
    fns['statusChangeLog.findFirst'].mockImplementation(async ({ where }: any) =>
      where.changedAt.gt.toISOString() === '2026-10-05T01:00:00.000Z' ? { changedAt: new Date('2026-10-05T04:00:00Z') } : { changedAt: new Date('2026-10-06T15:00:00Z') });
    fns['effortLog.findFirst'] = fns['effortLog.findFirst'] ?? jest.fn();
    fns['effortLog.findFirst'].mockResolvedValue(null);
    fns['effortLog.update'] = fns['effortLog.update'] ?? jest.fn();
    fns['effortLog.update'].mockImplementation(async ({ data }: any) => ({ id: OPEN_ID, ...data }));
  }
  it('미리보기: 3시간짜리는 OK, 14시간짜리는 TOO_LONG 으로 나뉘고 아무것도 수정하지 않는다', async () => {
    setupOpen();
    const r = await request(app).get('/attendance/admin/field-check/open-efforts');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.data.items.map((i: any) => [i.id, i]));
    expect(byId[OPEN_ID].verdict).toBe('OK');
    expect(byId[OPEN_ID].minutes).toBe(180);
    expect(byId[SLOW_ID].verdict).toBe('TOO_LONG');
    expect(r.body.data.applicable).toBe(1);
    expect(f('effortLog.update')).not.toHaveBeenCalled();
  });
  it('적용: OK 건만 ADMIN_ESTIMATE 로 닫고 TOO_LONG 은 건너뛴다', async () => {
    setupOpen();
    const r = await request(app).post('/attendance/admin/field-check/open-efforts/apply').send({ ids: [OPEN_ID, SLOW_ID] });
    expect(r.status).toBe(200);
    expect(r.body.data.applied).toBe(1);
    expect(r.body.data.skipped).toEqual([{ id: SLOW_ID, reason: 'TOO_LONG' }]);
    expect(f('effortLog.update')).toHaveBeenCalledTimes(1);
    const upd = f('effortLog.update').mock.calls[0][0];
    expect(upd.data.closedBy).toBe('ADMIN_ESTIMATE');
    expect(upd.data.endTime.toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });
  it('잘못된 기간/ids 는 400', async () => {
    setupOpen();
    let r = await request(app).get('/attendance/admin/field-check/open-efforts?from=2026-1-1');
    expect(r.status).toBe(400);
    r = await request(app).post('/attendance/admin/field-check/open-efforts/apply').send({ ids: ['x'] });
    expect(r.status).toBe(400);
  });
});

// ===== 2026-10-12: 위치 일치 강제(ENFORCE_LOCATION_MATCH) =====
describe('위치 일치 강제 — 고객사작업/미팅 (정책 ENFORCE_LOCATION_MATCH)', () => {
  const body = (extra: any = {}) => ({ status: 'CLIENT_WORK', siteType: 'ONSITE', locationStatus: 'OK', effort: baseEffort, ...extra });
  // 고객사(37.5,127.0)에서 약 1.5km 떨어진 원본 GPS와, 그 중간(고객사에서 약 750m·원본에서 약 750m)의 보정 지점
  const RAW_1_5KM = { lat: 37.5135, lng: 127.0 };
  const MID = { lat: 37.50675, lng: 127.0 };
  const notSaved = () => { expect(f('statusChangeLog.create')).not.toHaveBeenCalled(); expect(f('effortLog.create')).not.toHaveBeenCalled(); };

  it('[꺼짐=기본] 지도 보정으로도 일치하지 않는 위치는 예전처럼 불일치로 등록된다', async () => {
    setup();
    const r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: RAW_1_5KM }));
    expect(r.status).toBe(200);
    expect(r.body.data.locationMismatchException).toBe(true);
  });
  it('[켜짐] GPS 오차 1km 초과는 재측정을 몇 번 해도 등록되지 않는다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: FAR, accuracyMeters: 2800, outdoorRecheckCount: 5 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    expect(r.body.error.message).toContain('위치가 확인되어야만 등록');
    notSaved();
  });
  it('[켜짐] 오차가 큰 측정에 지도 보정(selfConfirm)을 붙여도 우회되지 않는다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: FAR, accuracyMeters: 2800, selfConfirmMismatch: true, confirmedLocation: FAR }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    notSaved();
  });
  it('[켜짐] 정확한 GPS로 멀리 있으면 지도 확인(LOCATION_MISMATCH_BLOCKED)을 거치고, 불일치 등록(그래도 등록)은 막힌다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    let r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50 }));
    expect(r.body.error.code).toBe('LOCATION_MISMATCH_BLOCKED');
    r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: RAW_1_5KM }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_CORRECTION_NOT_AT_TARGET');
    notSaved();
  });
  it('[켜짐] 지도 보정 위치가 원본 GPS 1km 이내이고 고객사 반경 안이면 "일치"로 등록되고 보정 표식이 남는다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: MID }));
    expect(r.status).toBe(200);
    expect(r.body.data.locationMismatchException).toBe(false);
    expect(r.body.data.locationMapCorrected).toBe(true);
    const data = f('statusChangeLog.create').mock.calls[0][0].data;
    expect(data.locationMatch).toBe(true);
    expect(data.note).toContain('GPS 위치 보정');
    expect(data.mismatchLatitude).toBeNull();
  });
  it('[켜짐] 지도 보정이 원본 GPS에서 1km를 넘게 떨어지면 정정으로 인정되지 않는다(스푸핑 방지 유지)', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: { lat: 37.5, lng: 127.0 } }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_CORRECTION_TOO_FAR');
    notSaved();
  });
  it('[켜짐] 위치를 못 구하면 사유를 적어도 등록되지 않는다(LOCATION_REQUIRED_STRICT)', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ locationStatus: 'PERMISSION_DENIED', locationFailureReason: '지하 기계실이라 GPS 불가' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_REQUIRED_STRICT');
    notSaved();
  });
  it('[켜짐] 고객사에 일치하는 위치는 그대로 등록된다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: NEAR, accuracyMeters: 30 }));
    expect(r.status).toBe(200);
    expect(f('statusChangeLog.create').mock.calls[0][0].data.locationMatch).toBe(true);
  });
  it('[켜짐] 원격 작업(siteType=REMOTE)은 위치 대조 대상이 아니라 그대로 등록된다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ siteType: 'REMOTE', location: FAR, accuracyMeters: 30 }));
    expect(r.status).toBe(200);
  });
  it('[켜짐] 야간작업은 이번 강제 대상이 아니어서 기존 규칙(재측정 후 통과)이 그대로 적용된다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    jest.setSystemTime(new Date('2026-10-13T10:00:00Z')); // 19:00 KST — 야간작업 등록 가능 시간대
    const r = await post(body({ status: 'NIGHT_WORK', location: FAR, accuracyMeters: 2800, outdoorRecheckCount: 1 }));
    expect(r.status).toBe(200);
  });
});

describe('위치 일치 강제 — 본사근무 (정책 ENFORCE_LOCATION_MATCH)', () => {
  beforeEach(() => { policy.HQ_LATITUDE = '37.4'; policy.HQ_LONGITUDE = '127.1'; });
  const hqEffort = { clientName: '본사업무', workType: '기술지원', startTime: '10:00', description: '내부 지원 업무 정리', workReason: '정기 업무' };
  const body = (extra: any = {}) => ({ status: 'HQ_WORKING', locationStatus: 'OK', effort: hqEffort, ...extra });
  const RAW_1_5KM = { lat: 37.4135, lng: 127.1 };
  const MID = { lat: 37.40675, lng: 127.1 };
  const notSaved = () => expect(f('statusChangeLog.create')).not.toHaveBeenCalled();

  it('[꺼짐=기본] 오차 큰 측정은 재측정 1회 뒤 불일치로 통과(기존 동작)', async () => {
    setup();
    const r = await post(body({ location: FAR, accuracyMeters: 2800, outdoorRecheckCount: 1 }));
    expect(r.status).toBe(200);
  });
  it('[켜짐] GPS 오차 1km 초과는 재측정을 몇 번 해도, 지도 보정을 붙여도 등록되지 않는다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    let r = await post(body({ location: FAR, accuracyMeters: 2800, outdoorRecheckCount: 5 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    r = await post(body({ location: FAR, accuracyMeters: 2800, selfConfirmMismatch: true, confirmedLocation: FAR }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    notSaved();
  });
  it('[켜짐] 정확한 GPS로 본사에서 멀면 지도 확인을 거치지만 본사 반경 밖이면 끝내 등록되지 않는다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    let r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50 }));
    expect(r.body.error.code).toBe('LOCATION_MISMATCH_BLOCKED');
    r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: RAW_1_5KM }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_CORRECTION_NOT_AT_TARGET');
    notSaved();
  });
  it('[꺼짐] 같은 상황에서 지도 확인 후 불일치로 등록된다(기존 동작)', async () => {
    setup();
    const r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: RAW_1_5KM }));
    expect(r.status).toBe(200);
    expect(f('statusChangeLog.create').mock.calls[0][0].data.locationMatch).toBe(false);
  });
  it('[켜짐] 지도 보정 위치가 본사 반경 안이면 일치로 등록되고 보정 표식이 남는다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: RAW_1_5KM, accuracyMeters: 50, selfConfirmMismatch: true, confirmedLocation: MID }));
    expect(r.status).toBe(200);
    const data = f('statusChangeLog.create').mock.calls[0][0].data;
    expect(data.locationMatch).toBe(true);
    expect(data.note).toContain('GPS 위치 보정');
  });
  it('[켜짐] 위치를 못 구하면 사유를 적어도 등록되지 않는다(LOCATION_REQUIRED_STRICT)', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ locationStatus: 'TIMEOUT', locationFailureReason: '지하라서 위치가 안 잡혀요' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_REQUIRED_STRICT');
    notSaved();
  });
  it('[켜짐] 본사 반경 안의 위치는 그대로 등록된다', async () => {
    setup(); policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await post(body({ location: { lat: 37.4001, lng: 127.1001 }, accuracyMeters: 30 }));
    expect(r.status).toBe(200);
    expect(f('statusChangeLog.create').mock.calls[0][0].data.locationMatch).toBe(true);
  });
});

describe('위치 일치 강제 — 출근 버튼 (정책 ENFORCE_LOCATION_MATCH)', () => {
  beforeEach(() => { policy.HQ_LATITUDE = '37.4'; policy.HQ_LONGITUDE = '127.1'; });
  const clockIn = (extra: any = {}) => request(app).post('/attendance/clock-in').send({ location: FAR, accuracyMeters: 2800, ...extra });
  it('[켜짐] 오차 큰 측정은 재측정을 몇 번 해도 출근이 확정되지 않는다', async () => {
    setup({ 'attendanceRecord.findUnique': null });
    fns['attendanceRecord.create'] = fns['attendanceRecord.create'] ?? jest.fn();
    fns['attendanceRecord.create'].mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
    policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await clockIn({ outdoorRecheckCount: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    expect(r.body.error.message).toContain('위치가 확인되어야만 등록');
    expect(f('attendanceRecord.create')).not.toHaveBeenCalled();
  });
  it('[켜짐] 오차 큰 측정에 지도 보정(selfConfirm)을 붙여도 우회되지 않는다', async () => {
    setup({ 'attendanceRecord.findUnique': null });
    fns['attendanceRecord.create'] = fns['attendanceRecord.create'] ?? jest.fn();
    fns['attendanceRecord.create'].mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
    policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await clockIn({ selfConfirmMismatch: true, confirmedLocation: FAR });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    expect(f('attendanceRecord.create')).not.toHaveBeenCalled();
  });
  it('[켜짐] 본사 반경 안의 정확한 위치로는 정상 출근된다', async () => {
    setup({ 'attendanceRecord.findUnique': null });
    fns['attendanceRecord.create'] = fns['attendanceRecord.create'] ?? jest.fn();
    fns['attendanceRecord.create'].mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
    policy.ENFORCE_LOCATION_MATCH = 1;
    const r = await clockIn({ location: { lat: 37.4001, lng: 127.1001 }, accuracyMeters: 30 });
    expect(r.status).toBe(200);
  });
});

describe('POST /attendance/clock-out — 작업내용·담당자 미입력 시 퇴근 차단 (정책 ENFORCE_EFFORT_COMPLETE_AT_CLOCKOUT)', () => {
  const dwl = { issues: '특이사항 없음', tomorrowPlan: '내일 점검' };
  function setupOut(efforts: any[]) {
    setup();
    policy.MIN_HOURS_BEFORE_CLOCKOUT = 0;
    fns['statusChangeLog.findFirst'] = fns['statusChangeLog.findFirst'] ?? jest.fn();
    fns['statusChangeLog.findFirst'].mockResolvedValue({ status: 'REMOTE', siteType: null });
    fns['attendanceRecord.update'] = fns['attendanceRecord.update'] ?? jest.fn();
    fns['attendanceRecord.update'].mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
    fns['effortLog.findMany'] = fns['effortLog.findMany'] ?? jest.fn();
    fns['effortLog.findMany'].mockResolvedValue(efforts);
  }
  const out = () => request(app).post('/attendance/clock-out').send({ dailyWorkLog: dwl });
  const noContact = { clientName: '코스콤', description: '서버 점검', contactId: null, contactName: null };
  const noDesc = { clientName: '코스콤', description: null, contactId: 'c1', contactName: null };
  const full = { clientName: '코스콤', description: '서버 점검', contactId: 'c1', contactName: null };

  it('[꺼짐=기본] 내용·담당자가 비어 있어도 퇴근은 그대로 된다', async () => {
    setupOut([noContact, noDesc]);
    const r = await out();
    expect(r.status).toBe(200);
  });
  it('[켜짐] 담당자가 비어 있으면 EFFORT_INCOMPLETE 로 막히고 퇴근이 저장되지 않는다', async () => {
    setupOut([noContact]); policy.ENFORCE_EFFORT_COMPLETE_AT_CLOCKOUT = 1;
    const r = await out();
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EFFORT_INCOMPLETE');
    expect(r.body.error.message).toContain('코스콤');
    expect(r.body.error.message).toContain('담당자');
    expect(f('attendanceRecord.update')).not.toHaveBeenCalled();
  });
  it('[켜짐] 작업내용이 비어 있으면 막힌다', async () => {
    setupOut([noDesc]); policy.ENFORCE_EFFORT_COMPLETE_AT_CLOCKOUT = 1;
    const r = await out();
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('작업(미팅) 내용');
  });
  it('[켜짐] 모두 채워져 있으면 퇴근된다', async () => {
    setupOut([full]); policy.ENFORCE_EFFORT_COMPLETE_AT_CLOCKOUT = 1;
    const r = await out();
    expect(r.status).toBe(200);
  });
  it('[켜짐] 개별 정책(ENFORCE_CLIENT_CONTACT=0)을 끄면 담당자 없음은 막지 않는다', async () => {
    setupOut([noContact]); policy.ENFORCE_EFFORT_COMPLETE_AT_CLOCKOUT = 1; policy.ENFORCE_CLIENT_CONTACT = 0;
    const r = await out();
    expect(r.status).toBe(200);
  });
});
