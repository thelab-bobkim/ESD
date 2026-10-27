// 위치 실패(출근/상태 등록 거절) 기록 · 관리자 요약을 DB 없이 검증한다.
jest.mock('../common/policy-engine/policy-engine', () => ({
  getPolicyNumber: async (_k: string, f: number) => f,
  getPolicyString: async (_k: string, f: string) => f,
  getPolicyBoolean: async (_k: string, f: boolean) => f,
  getPolicyJSON: async (_k: string, f: any) => f,
  setPolicyString: async () => undefined,
  setPolicyJSON: async () => undefined,
}));
const fns: Record<string, jest.Mock> = {};
function model(name: string) {
  return new Proxy({}, {
    get(_t, method: string) {
      const key = `${name}.${method}`;
      if (!fns[key]) fns[key] = jest.fn(async () => (method === 'findMany' || method === 'groupBy' ? [] : method === 'count' ? 0 : null));
      return fns[key];
    },
  });
}
const mockPrisma: any = new Proxy({ $transaction: async (fn: any) => fn(mockPrisma) }, { get(t: any, name: string) { return name in t ? t[name] : model(name); } });
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../common/guards/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.authUser = { userId: 'u1', roles: ['HR_ADMIN'] }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../common/audit', () => ({ recordAuditLog: jest.fn(async () => undefined) }));

import express from 'express';
import request from 'supertest';
import { createRouter } from '../common/async-router';
import { registerFieldCheckRoutes } from '../modules/attendance/field-check.routes';
import {
  classifyDevice, shouldRecordLocationFailure, buildLocationFailureRecord, locationFailureRecorder, summarizeLocationFailures,
  LOCATION_FAILURE_AUDIT_TARGET, type FailureEvent,
} from '../modules/attendance/location-failure-audit';

const f = (k: string) => fns[k] ?? (fns[k] = jest.fn(async () => null));
const audit = (jest.requireMock('../common/audit') as { recordAuditLog: jest.Mock }).recordAuditLog;
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const AND = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';

describe('위치 실패 기록 (순수 함수)', () => {
  it('User-Agent 에서 기기 종류만 뽑는다', () => {
    expect(classifyDevice(WIN)).toBe('PC');
    expect(classifyDevice(AND)).toBe('MOBILE');
    expect(classifyDevice('')).toBe('UNKNOWN');
    expect(classifyDevice(undefined)).toBe('UNKNOWN');
  });
  it('위치 관련 오류만 기록하고, 상태 등록의 불일치 막힘은 location_block 과 중복되므로 제외한다', () => {
    expect(shouldRecordLocationFailure('CLOCK_IN', 'GPS_ACCURACY_LOW')).toBe(true);
    expect(shouldRecordLocationFailure('STATUS', 'LOCATION_REQUIRED_STRICT')).toBe(true);
    expect(shouldRecordLocationFailure('CLOCK_IN', 'LOCATION_MISMATCH_BLOCKED')).toBe(true);
    expect(shouldRecordLocationFailure('STATUS', 'LOCATION_MISMATCH_BLOCKED')).toBe(false);
    expect(shouldRecordLocationFailure('STATUS', 'LOCATION_CORRECTION_NOT_AT_TARGET')).toBe(false);
    expect(shouldRecordLocationFailure('STATUS', 'INVALID_INPUT')).toBe(false);
    expect(shouldRecordLocationFailure('STATUS', undefined)).toBe(false);
  });
  it('기록에는 좌표·IP·User-Agent 원문이 들어가지 않는다', () => {
    const r = buildLocationFailureRecord({
      endpoint: 'STATUS', code: 'GPS_ACCURACY_LOW',
      reqBody: { status: 'HQ_WORKING', location: { lat: 37.123456, lng: 127.654321 }, accuracyMeters: 90, locationStatus: 'OK' },
      errorBody: { error: { code: 'GPS_ACCURACY_LOW', accuracyMeters: 1500 } }, userAgent: WIN,
    });
    expect(r).toEqual({ endpoint: 'STATUS', code: 'GPS_ACCURACY_LOW', status: 'HQ_WORKING', accuracyMeters: 1500, hasLocation: true, locationStatus: 'OK', device: 'PC' });
    expect(JSON.stringify(r)).not.toMatch(/37\.123|127\.654|Windows|Mozilla/);
  });
  it('출근 요청은 상태 값이 없고, 위치를 못 보낸 경우 hasLocation=false', () => {
    const r = buildLocationFailureRecord({ endpoint: 'CLOCK_IN', code: 'LOCATION_REQUIRED_FOR_CLOCKIN', reqBody: {}, errorBody: { error: {} }, userAgent: AND });
    expect(r).toMatchObject({ status: null, accuracyMeters: null, hasLocation: false, device: 'MOBILE' });
  });
});

describe('미들웨어: 오류 응답을 가로채 기록한다', () => {
  const app = express();
  app.use(express.json());
  const r = createRouter();
  r.use((req: any, _res: any, next: any) => { req.authUser = { userId: 'u1' }; next(); });
  r.use(locationFailureRecorder);
  r.post('/clock-in', (req: any, res: any) => res.status(req.body.fail ? 400 : 200).json(req.body.fail ? { success: false, error: { code: req.body.fail, message: 'x' } } : { success: true }));
  r.post('/status', (req: any, res: any) => res.status(req.body.fail ? 400 : 200).json(req.body.fail ? { success: false, error: { code: req.body.fail, message: 'x' } } : { success: true }));
  r.post('/clock-out', (_req: any, res: any) => res.status(400).json({ success: false, error: { code: 'GPS_ACCURACY_LOW' } }));
  app.use('/attendance', r);
  beforeEach(() => audit.mockClear());
  const calls = () => audit.mock.calls.map((c) => c[0]).filter((a: any) => a.targetType === LOCATION_FAILURE_AUDIT_TARGET);

  it('출근 버튼이 위치 때문에 거절되면 1건 기록하고 응답은 그대로다', async () => {
    const res = await request(app).post('/attendance/clock-in').set('User-Agent', WIN).send({ fail: 'LOCATION_REQUIRED_FOR_CLOCKIN', location: { lat: 1, lng: 2 }, accuracyMeters: 88 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LOCATION_REQUIRED_FOR_CLOCKIN');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ actorUserId: 'u1', actionType: 'STATUS_CHANGE', afterValue: { endpoint: 'CLOCK_IN', code: 'LOCATION_REQUIRED_FOR_CLOCKIN', device: 'PC', accuracyMeters: 88, hasLocation: true } });
  });
  it('성공 응답, 위치와 무관한 오류, 다른 경로(clock-out)는 기록하지 않는다', async () => {
    await request(app).post('/attendance/clock-in').send({});
    await request(app).post('/attendance/status').send({ fail: 'INVALID_INPUT' });
    await request(app).post('/attendance/clock-out').send({});
    expect(calls()).toHaveLength(0);
  });
  it('상태 등록의 위치 실패는 기록하되 불일치 막힘은 중복 기록하지 않는다', async () => {
    await request(app).post('/attendance/status').set('User-Agent', AND).send({ fail: 'GPS_ACCURACY_LOW', status: 'HQ_WORKING' });
    await request(app).post('/attendance/status').send({ fail: 'LOCATION_MISMATCH_BLOCKED', status: 'HQ_WORKING' });
    expect(calls()).toHaveLength(1);
    expect(calls()[0].afterValue).toMatchObject({ endpoint: 'STATUS', code: 'GPS_ACCURACY_LOW', status: 'HQ_WORKING', device: 'MOBILE' });
  });
  it('기록이 실패해도 사용자 응답에는 영향이 없다', async () => {
    audit.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/attendance/clock-in').send({ fail: 'GPS_ACCURACY_LOW' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GPS_ACCURACY_LOW');
  });
});

describe('summarizeLocationFailures', () => {
  const ev = (userId: string, name: string, min: number, code: string, device: 'PC' | 'MOBILE', acc: number | null): FailureEvent => ({
    at: new Date(Date.UTC(2026, 9, 12, 0, min)), userId, userName: name, endpoint: 'CLOCK_IN', code, status: null, accuracyMeters: acc, hasLocation: true, locationStatus: 'OK', device,
  });
  it('기기별·오류별·직원별로 모으고 최근 순으로 보여준다', () => {
    const s = summarizeLocationFailures([
      ev('a', '백해성', 1, 'GPS_ACCURACY_LOW', 'PC', 1500), ev('a', '백해성', 5, 'LOCATION_REQUIRED_FOR_CLOCKIN', 'PC', null), ev('a', '백해성', 9, 'GPS_ACCURACY_LOW', 'PC', 300),
      ev('b', '김', 3, 'GPS_ACCURACY_LOW', 'MOBILE', 200),
    ]);
    expect(s.total).toBe(4);
    expect(s.userCount).toBe(2);
    expect(s.byDevice[0]).toEqual({ device: 'PC', count: 3, userCount: 1 });
    expect(s.byCode[0]).toMatchObject({ code: 'GPS_ACCURACY_LOW', count: 3, userCount: 2 });
    expect(s.users[0]).toMatchObject({ userName: '백해성', count: 3, devices: ['PC'], medianAccuracyMeters: 900 });
    expect(s.recent[0].label).toBe('GPS 오차가 큼');
    expect(new Date(s.recent[0].at).getUTCMinutes()).toBe(9);
  });
  it('이벤트가 없으면 빈 요약', () => {
    expect(summarizeLocationFailures([])).toMatchObject({ total: 0, userCount: 0, byDevice: [], byCode: [], users: [], recent: [] });
  });
});

describe('GET /attendance/admin/field-check/location-failures', () => {
  const app = express();
  const fr = createRouter();
  registerFieldCheckRoutes(fr);
  app.use('/attendance', fr);
  beforeEach(() => { Object.values(fns).forEach((m) => m.mockReset()); audit.mockClear(); });

  it('기록을 요약하고 SAMPLE_ 계정을 빼며 조회를 감사로그에 남긴다', async () => {
    const d = (m: number) => new Date(Date.UTC(2026, 9, 12, 0, m));
    f('auditLog.findMany').mockResolvedValue([
      { actorUserId: 'u1', createdAt: d(5), afterValue: { endpoint: 'CLOCK_IN', code: 'GPS_ACCURACY_LOW', accuracyMeters: 1200, hasLocation: true, locationStatus: 'OK', device: 'PC' } },
      { actorUserId: 'sys', createdAt: d(6), afterValue: { endpoint: 'CLOCK_IN', code: 'GPS_ACCURACY_LOW', device: 'PC' } },
      { actorUserId: 'u1', createdAt: d(7), afterValue: { garbage: true } },
    ]);
    f('user.findMany').mockResolvedValue([{ id: 'u1', name: '백해성' }, { id: 'sys', name: 'SAMPLE_시스템관리자' }]);
    const res = await request(app).get('/attendance/admin/field-check/location-failures?days=7');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.users[0]).toMatchObject({ userName: '백해성', count: 1 });
    expect(f('auditLog.findMany').mock.calls[0][0].where.targetType).toBe(LOCATION_FAILURE_AUDIT_TARGET);
    const logs = audit.mock.calls.map((c) => c[0]).filter((a: any) => a.targetType === 'location_failures');
    expect(logs).toHaveLength(1);
    expect(logs[0].actionType).toBe('LOCATION_DETAIL_VIEW');
  });
  it('days 는 1~30으로 맞춘다', async () => {
    f('auditLog.findMany').mockResolvedValue([]);
    const res = await request(app).get('/attendance/admin/field-check/location-failures?days=999');
    expect(res.body.data.days).toBe(30);
  });
});
