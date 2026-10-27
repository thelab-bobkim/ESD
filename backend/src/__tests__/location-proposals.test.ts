// "등록된 고객사 위치가 실제와 달라요" 신청(직원) → 관리자 승인/반려 흐름을 DB 없이 검증한다.
const policyStore: Record<string, any> = {};
jest.mock('../common/policy-engine/policy-engine', () => ({
  getPolicyNumber: async (_k: string, f: number) => f,
  getPolicyString: async (_k: string, f: string) => f,
  getPolicyBoolean: async (_k: string, f: boolean) => f,
  getPolicyJSON: async (k: string, f: any) => (k in policyStore ? JSON.parse(JSON.stringify(policyStore[k])) : f),
  setPolicyJSON: async (k: string, v: any) => { policyStore[k] = JSON.parse(JSON.stringify(v)); },
  setPolicyString: async () => undefined,
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
const mockPrisma: any = new Proxy({ $transaction: async (fn: any) => fn(mockPrisma) }, {
  get(t: any, name: string) { return name in t ? t[name] : model(name); },
});
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));
let currentUser = { userId: 'u1', roles: ['EMPLOYEE'] };
jest.mock('../common/guards/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.authUser = currentUser; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../common/audit', () => ({ recordAuditLog: jest.fn(async () => undefined) }));
const pushMock = jest.fn(async () => undefined);
jest.mock('../common/push', () => ({ sendPushToUser: (...a: any[]) => (pushMock as any)(...a), isPushConfigured: () => true }));

import express from 'express';
import request from 'supertest';
import { createRouter } from '../common/async-router';
import { registerLocationProposalRoutes } from '../modules/attendance/location-proposal.routes';
import { clientsRouter } from '../modules/clients/clients.routes';
import { upsertProposal, groupProposals, clusterOf, purgeExpired, type LocationProposal } from '../modules/clients/location-proposals';

const f = (k: string) => fns[k] ?? (fns[k] = jest.fn(async () => null));
const audit = (jest.requireMock('../common/audit') as { recordAuditLog: jest.Mock }).recordAuditLog;

const CID = '11111111-1111-4111-8111-111111111111';
const CLIENT = { id: CID, name: '메타온넷', address: '서울 어딘가 1', latitude: 37.5, longitude: 127.0 };
const mk = (over: Partial<LocationProposal> = {}): LocationProposal => ({
  id: 'p1', userId: 'u1', userName: '김가', createdAt: '2026-10-13T01:00:00.000Z', status: 'CLIENT_WORK', clientId: CID, clientName: '메타온넷',
  lat: 37.52, lng: 127.02, accuracyMeters: 30, distanceMeters: 2800, note: null, ...over,
});

describe('신청 목록 순수 함수', () => {
  it('같은 직원이 같은 고객사로 다시 신청하면 이전 신청을 대체한다', () => {
    const out = upsertProposal([mk()], mk({ id: 'p2', lat: 37.53 }));
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('p2');
  });
  it('직원당 5건을 넘으면 가장 오래된 것부터 버린다', () => {
    let list: LocationProposal[] = [];
    for (let i = 0; i < 6; i++) list = upsertProposal(list, mk({ id: `p${i}`, clientId: `c${i}`, createdAt: `2026-10-13T0${i}:00:00.000Z` }));
    expect(list).toHaveLength(5);
    expect(list.find((p) => p.id === 'p0')).toBeUndefined();
  });
  it('같은 고객사·300m 이내는 한 묶음이고, 제안 좌표는 서로 다른 직원 최신 위치의 평균이다', () => {
    const list = [
      mk({ id: 'a', userId: 'u1', lat: 37.5200, lng: 127.0200, createdAt: '2026-10-13T01:00:00.000Z' }),
      mk({ id: 'b', userId: 'u2', userName: '이나', lat: 37.5210, lng: 127.0210, createdAt: '2026-10-13T02:00:00.000Z' }),
      mk({ id: 'c', userId: 'u1', lat: 37.9, lng: 127.9, clientId: 'other' }),
    ];
    const g = groupProposals(list);
    expect(g).toHaveLength(2);
    const main = g.find((x) => x.clientId === CID)!;
    expect(main.userCount).toBe(2);
    expect(main.centerLat).toBeCloseTo(37.5205, 3);
    expect(clusterOf(list, 'a')!.members.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
  it('같은 고객사라도 300m 넘게 떨어진 신청은 다른 묶음(다른 지점일 수 있음)', () => {
    const g = groupProposals([mk({ id: 'a' }), mk({ id: 'b', userId: 'u2', lat: 37.55, lng: 127.05 })]);
    expect(g).toHaveLength(2);
  });
  it('30일이 지난 신청은 정리한다', () => {
    const out = purgeExpired([mk({ createdAt: '2026-08-01T00:00:00.000Z' }), mk({ id: 'p9' })], new Date('2026-10-13T00:00:00Z'));
    expect(out.map((p) => p.id)).toEqual(['p9']);
  });
});

const empApp = express();
empApp.use(express.json());
const er = createRouter();
er.use((req: any, _res: any, next: any) => { req.authUser = currentUser; next(); });
registerLocationProposalRoutes(er);
empApp.use('/attendance', er);

const body = (extra: any = {}) => ({
  clientName: '메타온넷', clientId: CID, status: 'CLIENT_WORK',
  location: { lat: 37.5195, lng: 127.0195 }, confirmedLocation: { lat: 37.52, lng: 127.02 }, accuracyMeters: 30, ...extra,
});

describe('POST /attendance/location-proposals (직원)', () => {
  beforeEach(() => {
    Object.keys(policyStore).forEach((k) => delete policyStore[k]);
    Object.values(fns).forEach((m) => m.mockReset());
    audit.mockClear(); pushMock.mockClear();
    currentUser = { userId: 'u1', roles: ['EMPLOYEE'] };
    f('client.findUnique').mockResolvedValue(CLIENT);
    f('client.findFirst').mockResolvedValue(CLIENT);
    f('user.findUnique').mockResolvedValue({ name: '김가' });
    f('user.findMany').mockResolvedValue([{ id: 'adm1' }]);
  });
  it('정상 신청은 저장되고 관리자에게 푸시가 가며, 고객사 좌표는 바뀌지 않는다', async () => {
    const r = await request(empApp).post('/attendance/location-proposals').send(body());
    expect(r.status).toBe(200);
    expect(r.body.data.distanceMeters).toBeGreaterThan(2000);
    expect(policyStore.CLIENT_LOCATION_PROPOSALS).toHaveLength(1);
    expect(policyStore.CLIENT_LOCATION_PROPOSALS[0]).toMatchObject({ clientId: CID, userId: 'u1', lat: 37.52, lng: 127.02 });
    expect(f('client.update')).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls.map((c) => c[0].targetType)).toContain('client_location_proposal');
  });
  it('GPS 오차가 300m를 넘거나 측정값이 없으면 거절한다', async () => {
    let r = await request(empApp).post('/attendance/location-proposals').send(body({ accuracyMeters: 800 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    r = await request(empApp).post('/attendance/location-proposals').send(body({ accuracyMeters: undefined }));
    expect(r.body.error.code).toBe('GPS_ACCURACY_LOW');
    expect(policyStore.CLIENT_LOCATION_PROPOSALS).toBeUndefined();
  });
  it('지도로 확정한 위치가 실제 측정된 GPS에서 1km를 넘게 떨어지면 거절한다(임의의 장소 불가)', async () => {
    const r = await request(empApp).post('/attendance/location-proposals').send(body({ confirmedLocation: { lat: 37.6, lng: 127.1 } }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LOCATION_CORRECTION_TOO_FAR');
  });
  it('이미 등록 위치 근처면 신청이 필요 없다(ALREADY_MATCHED)', async () => {
    const r = await request(empApp).post('/attendance/location-proposals').send(body({ location: { lat: 37.5001, lng: 127.0001 }, confirmedLocation: { lat: 37.5001, lng: 127.0001 } }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ALREADY_MATCHED');
  });
  it('위치가 등록되지 않았거나 없는 고객사는 거절한다', async () => {
    f('client.findUnique').mockResolvedValue({ ...CLIENT, latitude: null, longitude: null });
    let r = await request(empApp).post('/attendance/location-proposals').send(body());
    expect(r.status).toBe(404);
    f('client.findUnique').mockResolvedValue(null);
    r = await request(empApp).post('/attendance/location-proposals').send(body());
    expect(r.status).toBe(404);
  });
  it('고객사작업/미팅 외 상태나 잘못된 입력은 INVALID_INPUT', async () => {
    const r = await request(empApp).post('/attendance/location-proposals').send(body({ status: 'HQ_WORKING' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_INPUT');
  });
  it('대기 신청이 직원당 5건이면 새 고객사 신청은 막는다', async () => {
    policyStore.CLIENT_LOCATION_PROPOSALS = Array.from({ length: 5 }, (_, i) => mk({ id: `x${i}`, clientId: `cc${i}`, createdAt: new Date().toISOString() }));
    const r = await request(empApp).post('/attendance/location-proposals').send(body());
    expect(r.status).toBe(429);
  });
});

const admApp = express();
admApp.use(express.json());
admApp.use('/clients', clientsRouter);

describe('관리자 승인/반려 (/clients/location-proposals)', () => {
  const now = () => new Date().toISOString();
  beforeEach(() => {
    Object.keys(policyStore).forEach((k) => delete policyStore[k]);
    Object.values(fns).forEach((m) => m.mockReset());
    audit.mockClear(); pushMock.mockClear();
    currentUser = { userId: 'admin1', roles: ['HR_ADMIN'] };
    policyStore.CLIENT_LOCATION_PROPOSALS = [
      mk({ id: 'a', userId: 'u1', lat: 37.5200, lng: 127.0200, createdAt: now() }),
      mk({ id: 'b', userId: 'u2', userName: '이나', lat: 37.5210, lng: 127.0210, createdAt: now() }),
      mk({ id: 'z', userId: 'u3', clientId: 'other', clientName: '코스콤', lat: 37.9, lng: 127.9, createdAt: now() }),
    ];
    f('client.findMany').mockResolvedValue([CLIENT]);
    f('client.findUnique').mockResolvedValue(CLIENT);
    f('client.update').mockResolvedValue({});
  });
  it('목록은 같은 고객사·가까운 위치끼리 묶어 제안 좌표·거리·신청 인원을 보여준다', async () => {
    const r = await request(admApp).get('/clients/location-proposals');
    expect(r.status).toBe(200);
    const main = r.body.data.find((x: any) => x.clientId === CID);
    expect(main.userCount).toBe(2);
    expect(main.proposedLat).toBeCloseTo(37.5205, 3);
    expect(main.distanceFromRegisteredMeters).toBeGreaterThan(2000);
  });
  it('승인하면 평균 위치로 고객사 좌표를 바꾸고, 그 묶음만 정리하며, 신청 직원 모두에게 알린다', async () => {
    const r = await request(admApp).post('/clients/location-proposals/a/approve').send({});
    expect(r.status).toBe(200);
    expect(f('client.update')).toHaveBeenCalledTimes(1);
    const arg = f('client.update').mock.calls[0][0];
    expect(arg.where).toEqual({ id: CID });
    expect(arg.data.latitude).toBeCloseTo(37.5205, 3);
    expect(policyStore.CLIENT_LOCATION_PROPOSALS.map((p: any) => p.id)).toEqual(['z']);
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect((pushMock.mock.calls[0] as any[])[1].body).toContain('메타온넷');
    const log = audit.mock.calls.map((c) => c[0]).find((a: any) => a.targetType === 'client_location_proposal_approved');
    expect(log.beforeValue).toMatchObject({ latitude: 37.5, longitude: 127.0 });
  });
  it('반려하면 고객사 좌표는 그대로이고 신청은 정리되며 사유가 직원에게 전달된다', async () => {
    const r = await request(admApp).post('/clients/location-proposals/b/reject').send({ reason: '다른 지점이에요' });
    expect(r.status).toBe(200);
    expect(f('client.update')).not.toHaveBeenCalled();
    expect(policyStore.CLIENT_LOCATION_PROPOSALS.map((p: any) => p.id)).toEqual(['z']);
    expect((pushMock.mock.calls[0] as any[])[1].body).toContain('다른 지점이에요');
  });
  it('이미 처리되었거나 없는 신청은 404, 삭제된 고객사의 신청은 정리만 한다', async () => {
    let r = await request(admApp).post('/clients/location-proposals/nope/approve').send({});
    expect(r.status).toBe(404);
    f('client.findUnique').mockResolvedValue(null);
    r = await request(admApp).post('/clients/location-proposals/a/approve').send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('CLIENT_NOT_FOUND');
    expect(f('client.update')).not.toHaveBeenCalled();
    expect(policyStore.CLIENT_LOCATION_PROPOSALS.map((p: any) => p.id)).toEqual(['z']);
  });
});
