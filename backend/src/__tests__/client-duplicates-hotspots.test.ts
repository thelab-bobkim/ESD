// 중복 고객사 점검(생물 / 국립생물자원관) · 합치기 · 매일 8시 알림 · 방문지 점검(반복 불일치) 을 DB 없이 검증한다.
jest.mock('../common/policy-engine/policy-engine', () => ({
  getPolicyNumber: async (_k: string, f: number) => f,
  getPolicyString: async (k: string, f: string) => (k === 'HQ_LATITUDE' ? '37.4' : k === 'HQ_LONGITUDE' ? '127.1' : f),
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
const mockPrisma: any = new Proxy({ $transaction: async (fn: any) => fn(mockPrisma) }, {
  get(t: any, name: string) { return name in t ? t[name] : model(name); },
});
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../common/guards/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.authUser = { userId: 'admin1', roles: ['HR_ADMIN'] }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../common/audit', () => ({ recordAuditLog: jest.fn(async () => undefined) }));
const pushMock = jest.fn(async () => undefined);
jest.mock('../common/push', () => ({ sendPushToUser: (...a: any[]) => (pushMock as any)(...a), isPushConfigured: () => true }));

import express from 'express';
import request from 'supertest';
import { findDuplicateGroups, namesRelated, normalizeAddress } from '../modules/clients/client-duplicates';
import { clientsRouter } from '../modules/clients/clients.routes';
import { runClientDuplicateCheck } from '../modules/clients/client-duplicate-notifier';
import { parseClientFromNote, clusterMismatchPoints, classifyHotspots, summarizeBlockedEvents, type MismatchPoint } from '../modules/attendance/location-hotspots';
import { registerFieldCheckRoutes } from '../modules/attendance/field-check.routes';
import { createRouter } from '../common/async-router';

const f = (k: string) => fns[k] ?? (fns[k] = jest.fn(async () => null));
const audit = (jest.requireMock('../common/audit') as { recordAuditLog: jest.Mock }).recordAuditLog;

const A = '인천광역시 서구 환경로 42';
const SAENGMUL = { id: '11111111-1111-4111-8111-111111111111', name: '생물', address: A, latitude: 37.5, longitude: 126.7 };
const NIBR = { id: '22222222-2222-4222-8222-222222222222', name: '국립생물자원관', address: '인천 서구 환경로 42', latitude: 37.5, longitude: 126.7 };

describe('중복 고객사 판별 (순수 함수)', () => {
  it('주소 표기가 조금 달라도 공백·기호를 제거해 비교한다', () => {
    expect(normalizeAddress('인천 서구 환경로 42')).toBe(normalizeAddress('인천 서구, 환경로42'));
  });
  it('시·도 표기만 다른 주소(인천광역시/인천, 경기도/경기)도 같은 주소로 본다', () => {
    expect(normalizeAddress('인천광역시 서구 환경로 42')).toBe(normalizeAddress('인천 서구 환경로 42'));
    expect(normalizeAddress('경기도 화성시 병점구 1')).toBe(normalizeAddress('경기 화성시 병점구 1'));
    expect(normalizeAddress('충청남도 천안시 1')).toBe(normalizeAddress('충남 천안시 1'));
    expect(normalizeAddress('인천 서구 환경로 42')).not.toBe(normalizeAddress('서울 서구 환경로 42'));
  });
  it('이름이 서로 포함되면 같은 곳의 줄임말로 본다 (최소 2글자)', () => {
    expect(namesRelated('생물', '국립생물자원관')).toBe(true);
    expect(namesRelated('A', 'ABC')).toBe(false);
  });
  it('주소가 같고 이름이 포함 관계면 HIGH, 가장 구체적인 이름을 남기기로 추천한다', () => {
    const g = findDuplicateGroups([SAENGMUL, { ...NIBR, address: '인천 서구 환경로 42', latitude: null as any, longitude: null as any }, { id: 'x', name: '다른곳', address: '서울 어딘가 1', latitude: null, longitude: null }]);
    expect(g).toHaveLength(1);
    expect(g[0].confidence).toBe('HIGH');
    expect(g[0].suggestedKeepId).toBe(NIBR.id);
  });
  it('같은 건물의 다른 회사(주소만 같고 이름 무관, 좌표도 멀다)는 LOW 로 표시한다', () => {
    const g = findDuplicateGroups([
      { id: 'a', name: '가나다전자', address: '서울 강남구 테헤란로 1', latitude: 37.5, longitude: 127.0 },
      { id: 'b', name: '마바사소프트', address: '서울 강남구 테헤란로 1', latitude: 37.52, longitude: 127.02 },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].confidence).toBe('LOW');
  });
  it('이름이 달라도 좌표가 50m 안이면 HIGH', () => {
    const g = findDuplicateGroups([
      { id: 'a', name: '가나다전자', address: '서울 강남구 테헤란로 1', latitude: 37.5, longitude: 127.0 },
      { id: 'b', name: '마바사소프트', address: '서울 강남구 테헤란로 1', latitude: 37.50001, longitude: 127.00001 },
    ]);
    expect(g[0].confidence).toBe('HIGH');
  });
  it('SAMPLE_ 고객사와 주소가 비었거나 너무 짧은 고객사는 비교하지 않는다', () => {
    expect(findDuplicateGroups([
      { id: 'a', name: 'SAMPLE_1', address: '서울 강남구 테헤란로 1', latitude: null, longitude: null },
      { id: 'b', name: 'SAMPLE_2', address: '서울 강남구 테헤란로 1', latitude: null, longitude: null },
      { id: 'c', name: '가', address: '', latitude: null, longitude: null },
      { id: 'd', name: '나', address: '', latitude: null, longitude: null },
    ])).toEqual([]);
  });
});

const app = express();
app.use(express.json());
app.use('/clients', clientsRouter);

describe('GET /clients/duplicates', () => {
  beforeEach(() => { Object.values(fns).forEach((m) => m.mockClear()); });
  it('중복 묶음과 각 고객사의 연결 데이터 수를 내려준다 (삭제는 하지 않는다)', async () => {
    f('client.findMany').mockResolvedValue([SAENGMUL, NIBR]);
    f('project.groupBy').mockResolvedValue([{ clientId: SAENGMUL.id, _count: { _all: 3 } }]);
    f('effortLog.groupBy').mockResolvedValue([{ clientName: '생물', _count: { _all: 12 } }]);
    const r = await request(app).get('/clients/duplicates');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    const g = r.body.data[0];
    expect(g.suggestedKeepId).toBe(NIBR.id);
    const s = g.clients.find((c: any) => c.id === SAENGMUL.id);
    expect(s.usage).toMatchObject({ projects: 3, effortLogs: 12 });
    expect(s.looksSameAsSuggested).toBe(true);
    expect(f('client.delete')).not.toHaveBeenCalled();
  });
  it('중복이 없으면 빈 목록', async () => {
    f('client.findMany').mockResolvedValue([SAENGMUL]);
    const r = await request(app).get('/clients/duplicates');
    expect(r.body.data).toEqual([]);
  });
});

describe('POST /clients/merge', () => {
  beforeEach(() => {
    Object.values(fns).forEach((m) => m.mockReset());
    audit.mockClear();
  });
  const body = (extra: any = {}) => ({ keepId: NIBR.id, removeIds: [SAENGMUL.id], ...extra });
  function arrange() {
    f('client.findMany').mockResolvedValue([SAENGMUL, NIBR]);
    f('clientContact.findMany').mockImplementation(async ({ where }: any) =>
      where.clientId === NIBR.id ? [{ id: 'kc1', name: '김대리' }] : [{ id: 'rc1', name: '김대리' }, { id: 'rc2', name: '박과장' }]);
    for (const k of ['effortLog.updateMany', 'user.updateMany', 'residentCheckin.updateMany', 'project.updateMany']) f(k).mockResolvedValue({ count: 2 });
    f('clientContact.delete').mockResolvedValue({});
    f('clientContact.update').mockResolvedValue({});
    f('client.delete').mockResolvedValue({});
  }
  it('남길 쪽으로 직원 배정·도착체크·프로젝트·담당자·공수 이름을 옮긴 뒤 지우고 감사로그를 남긴다', async () => {
    arrange();
    const r = await request(app).post('/clients/merge').send(body());
    expect(r.status).toBe(200);
    expect(f('user.updateMany')).toHaveBeenCalledWith({ where: { assignedClientId: SAENGMUL.id }, data: { assignedClientId: NIBR.id } });
    expect(f('project.updateMany')).toHaveBeenCalledWith({ where: { clientId: SAENGMUL.id }, data: { clientId: NIBR.id } });
    expect(f('residentCheckin.updateMany')).toHaveBeenCalledWith({ where: { clientId: SAENGMUL.id }, data: { clientId: NIBR.id } });
    expect(f('effortLog.updateMany')).toHaveBeenCalledWith({ where: { clientName: '생물' }, data: { clientName: '국립생물자원관' } });
    // 같은 이름 담당자는 공수 연결만 옮기고 정리, 새 담당자는 이전
    expect(f('effortLog.updateMany')).toHaveBeenCalledWith({ where: { contactId: 'rc1' }, data: { contactId: 'kc1' } });
    expect(f('clientContact.delete')).toHaveBeenCalledWith({ where: { id: 'rc1' } });
    expect(f('clientContact.update')).toHaveBeenCalledWith({ where: { id: 'rc2' }, data: { clientId: NIBR.id } });
    expect(f('client.delete')).toHaveBeenCalledWith({ where: { id: SAENGMUL.id } });
    expect(r.body.data).toMatchObject({ contactsMoved: 1, contactsMerged: 1, removed: ['생물'] });
    const logs = audit.mock.calls.map((c) => c[0]).filter((a: any) => a.targetType === 'client_merge');
    expect(logs).toHaveLength(1);
    expect(logs[0].actionType).toBe('CORRECT');
  });
  it('남길 쪽에 좌표가 없고 합칠 쪽에 있으면 좌표를 물려받는다 / 이미 있으면 건드리지 않는다', async () => {
    arrange();
    f('client.findMany').mockResolvedValue([SAENGMUL, { ...NIBR, latitude: null, longitude: null }]);
    f('client.update').mockResolvedValue({});
    let r = await request(app).post('/clients/merge').send(body());
    expect(r.status).toBe(200);
    expect(f('client.update')).toHaveBeenCalledWith({ where: { id: NIBR.id }, data: { latitude: 37.5, longitude: 126.7 } });
    expect(r.body.data.coordinatesCopied).toBe(true);
    f('client.update').mockClear();
    f('client.findMany').mockResolvedValue([SAENGMUL, NIBR]);
    r = await request(app).post('/clients/merge').send(body());
    expect(f('client.update')).not.toHaveBeenCalled();
    expect(r.body.data.coordinatesCopied).toBe(false);
  });
  it('renameEffortLogs=false 면 과거 공수 기록의 고객사 이름은 그대로 둔다', async () => {
    arrange();
    await request(app).post('/clients/merge').send(body({ renameEffortLogs: false }));
    expect(f('effortLog.updateMany')).not.toHaveBeenCalledWith({ where: { clientName: '생물' }, data: { clientName: '국립생물자원관' } });
    expect(f('client.delete')).toHaveBeenCalled();
  });
  it('주소가 서로 다른 고객사는 합칠 수 없다 (ADDRESS_MISMATCH, 아무것도 지우지 않음)', async () => {
    arrange();
    f('client.findMany').mockResolvedValue([SAENGMUL, { ...NIBR, address: '서울 종로구 세종대로 1' }]);
    const r = await request(app).post('/clients/merge').send(body());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ADDRESS_MISMATCH');
    expect(f('client.delete')).not.toHaveBeenCalled();
    expect(f('project.updateMany')).not.toHaveBeenCalled();
  });
  it('남길 고객사를 합칠 대상에 넣거나 존재하지 않는 id 면 거절한다', async () => {
    arrange();
    let r = await request(app).post('/clients/merge').send(body({ removeIds: [NIBR.id] }));
    expect(r.status).toBe(400);
    f('client.findMany').mockResolvedValue([NIBR]);
    r = await request(app).post('/clients/merge').send(body());
    expect(r.status).toBe(404);
    expect(f('client.delete')).not.toHaveBeenCalled();
  });
  it('uuid 가 아닌 입력은 INVALID_INPUT', async () => {
    const r = await request(app).post('/clients/merge').send({ keepId: 'x', removeIds: ['y'] });
    expect(r.status).toBe(400);
  });
});

describe('매일 오전 8시 중복 고객사 알림 (runClientDuplicateCheck)', () => {
  beforeEach(() => { Object.values(fns).forEach((m) => m.mockReset()); pushMock.mockClear(); });
  it('거의 확실한 중복이 있으면 활성 관리자에게 푸시를 보낸다', async () => {
    f('client.findMany').mockResolvedValue([SAENGMUL, NIBR]);
    f('user.findMany').mockResolvedValue([{ id: 'adm1' }, { id: 'adm2' }]);
    const r = await runClientDuplicateCheck(new Date('2026-10-13T23:00:00Z'));
    expect(r).toEqual({ notified: 2, groups: 1 });
    expect(pushMock).toHaveBeenCalledTimes(2);
    const arg = (pushMock.mock.calls[0] as any[])[1];
    expect(arg.body).toContain('생물');
    expect(arg.body).toContain('국립생물자원관');
    expect(arg.url).toBe('/admin/clients');
  });
  it('중복이 없거나 확인 필요(LOW)뿐이면 알리지 않는다', async () => {
    f('client.findMany').mockResolvedValue([
      { id: 'a', name: '가나다전자', address: '서울 강남구 테헤란로 1', latitude: 37.5, longitude: 127.0 },
      { id: 'b', name: '마바사소프트', address: '서울 강남구 테헤란로 1', latitude: 37.52, longitude: 127.02 },
    ]);
    const r = await runClientDuplicateCheck();
    expect(r).toEqual({ notified: 0, groups: 0 });
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('방문지 점검 (순수 함수)', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 12, h));
  const pt = (userId: string, lat: number, lng: number, h = 1, clientName: string | null = null, status = 'CLIENT_WORK'): MismatchPoint =>
    ({ userId, userName: userId, lat, lng, changedAt: t(h), status, clientName });

  it('상태 note 에서 고객사명을 꺼낸다', () => {
    expect(parseClientFromNote('고객사: 메타온넷 | 작업: 점검')).toBe('메타온넷');
    expect(parseClientFromNote('고객사: 메타온넷')).toBe('메타온넷');
    expect(parseClientFromNote('고객사: - | x')).toBeNull();
    expect(parseClientFromNote(null)).toBeNull();
  });
  it('300m 안의 지점은 한 묶음으로 묶고 먼 지점은 따로 둔다', () => {
    const c = clusterMismatchPoints([pt('a', 37.5, 127.0), pt('b', 37.5005, 127.0), pt('c', 37.6, 127.2)]);
    expect(c.map((x) => x.points.length).sort()).toEqual([1, 2]);
  });
  it('등록 고객사가 없는 곳에서 2명 이상 반복되면 미등록 방문지 후보', () => {
    const { hotspots } = classifyHotspots(
      clusterMismatchPoints([pt('a', 37.7, 127.3, 1, '메타온넷'), pt('b', 37.7001, 127.3001, 2, '메타온넷')]),
      [{ name: '코스콤', latitude: 37.5, longitude: 127.0 }], { lat: 37.4, lng: 127.1 });
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]).toMatchObject({ kind: 'UNREGISTERED', userCount: 2, count: 2 });
    expect(hotspots[0].chosenClients[0]).toEqual({ name: '메타온넷', count: 2 });
  });
  it('등록 고객사 1km 안이면 "근처인데 어긋남"으로 분류한다', () => {
    const { hotspots } = classifyHotspots(
      clusterMismatchPoints([pt('a', 37.505, 127.0), pt('b', 37.5051, 127.0001)]),
      [{ name: '코스콤', latitude: 37.5, longitude: 127.0 }], { lat: 37.4, lng: 127.1 });
    expect(hotspots[0].kind).toBe('NEAR_OTHER_CLIENT');
    expect(hotspots[0].nearestClient?.name).toBe('코스콤');
  });
  it('본사 반경(1km) 안의 묶음은 후보에서 빼고, 1명이 2건뿐인 묶음은 반복으로 보지 않는다', () => {
    const r = classifyHotspots(
      [...clusterMismatchPoints([pt('a', 37.4001, 127.1001), pt('b', 37.4002, 127.1002)]), ...clusterMismatchPoints([pt('c', 37.8, 127.8), pt('c', 37.8001, 127.8001, 2)])],
      [], { lat: 37.4, lng: 127.1 });
    expect(r.hotspots).toHaveLength(0);
    expect(r.hqAreaClusters).toBe(1);
  });
  it('중심 좌표는 소수 셋째 자리(약 100m)로만 내려준다', () => {
    const { hotspots } = classifyHotspots(clusterMismatchPoints([pt('a', 37.712345, 127.312345), pt('b', 37.712355, 127.312355)]), [], null);
    expect(hotspots[0].centerLat).toBe(37.712);
    expect(hotspots[0].centerLng).toBe(127.312);
  });
  it('막힌 시도를 고객사별로 모아 2명 이상이면 좌표 의심으로 표시한다', () => {
    const s = summarizeBlockedEvents([
      { userId: 'a', userName: '가', kind: 'CLIENT', clientName: '메타온넷', distanceMeters: 800 },
      { userId: 'b', userName: '나', kind: 'CLIENT', clientName: '메타온넷', distanceMeters: 1200 },
      { userId: 'a', userName: '가', kind: 'CLIENT', clientName: '코스콤', distanceMeters: 300 },
      { userId: 'c', userName: '다', kind: 'HQ', clientName: null, distanceMeters: 50000 },
    ]);
    expect(s.clients[0]).toMatchObject({ clientName: '메타온넷', userCount: 2, count: 2, suspectCoordinates: true, medianDistanceMeters: 1000 });
    expect(s.clients[1]).toMatchObject({ clientName: '코스콤', suspectCoordinates: false });
    expect(s.hq).toMatchObject({ count: 1, userCount: 1 });
  });
});

describe('GET /attendance/admin/field-check/location-hotspots', () => {
  const fieldApp = express();
  const fr = createRouter();
  registerFieldCheckRoutes(fr);
  fieldApp.use('/attendance', fr);
  beforeEach(() => { Object.values(fns).forEach((m) => m.mockReset()); audit.mockClear(); });

  it('불일치 좌표를 묶어 후보를 만들고, 막힌 시도를 고객사별로 요약하며, 조회를 감사로그에 남긴다', async () => {
    const d = (h: number) => new Date(Date.UTC(2026, 9, 12, h));
    f('statusChangeLog.findMany').mockResolvedValue([
      { userId: 'u1', status: 'CLIENT_WORK', changedAt: d(1), note: '고객사: 메타온넷 | x', mismatchLatitude: 37.7, mismatchLongitude: 127.3, user: { name: '김' } },
      { userId: 'u2', status: 'CLIENT_MEETING', changedAt: d(2), note: '고객사: 메타온넷 | y', mismatchLatitude: 37.7001, mismatchLongitude: 127.3001, user: { name: '이' } },
    ]);
    f('auditLog.findMany').mockResolvedValue([
      { actorUserId: 'u1', afterValue: { kind: 'CLIENT', clientName: '메타온넷', distanceMeters: 900, phase: 'FIRST' } },
      { actorUserId: 'u2', afterValue: { kind: 'CLIENT', clientName: '메타온넷', distanceMeters: 1100, phase: 'CORRECTED_FAILED' } },
      { actorUserId: 'u2', afterValue: { garbage: true } },
    ]);
    f('client.findMany').mockResolvedValue([{ name: '코스콤', latitude: 37.5, longitude: 127.0 }]);
    f('user.findMany').mockResolvedValue([{ id: 'u1', name: '김' }, { id: 'u2', name: '이' }]);
    const r = await request(fieldApp).get('/attendance/admin/field-check/location-hotspots?days=7');
    expect(r.status).toBe(200);
    expect(r.body.data.days).toBe(7);
    expect(r.body.data.hotspots).toHaveLength(1);
    expect(r.body.data.hotspots[0]).toMatchObject({ kind: 'UNREGISTERED', userCount: 2 });
    expect(r.body.data.blocked.total).toBe(2);
    expect(r.body.data.blocked.correctedFailed).toBe(1);
    expect(r.body.data.blocked.clients[0]).toMatchObject({ clientName: '메타온넷', userCount: 2, suspectCoordinates: true });
    // 응답 어디에도 개별 원본 좌표(소수 4자리 이상)는 없다
    expect(JSON.stringify(r.body)).not.toMatch(/37\.7001|127\.3001/);
    const logs = audit.mock.calls.map((c) => c[0]).filter((a: any) => a.targetType === 'location_hotspots');
    expect(logs).toHaveLength(1);
    expect(logs[0].actionType).toBe('LOCATION_DETAIL_VIEW');
    // 조회 기간은 보관기간(30일)을 넘지 못한다
    const where = f('statusChangeLog.findMany').mock.calls[0][0].where;
    expect(Date.now() - where.changedAt.gte.getTime()).toBeLessThan(31 * 86_400_000 + 1000);
  });
  it('days 가 범위를 벗어나면 1~30일로 맞춘다', async () => {
    for (const k of ['statusChangeLog.findMany', 'auditLog.findMany', 'client.findMany']) f(k).mockResolvedValue([]);
    const r = await request(fieldApp).get('/attendance/admin/field-check/location-hotspots?days=999');
    expect(r.body.data.days).toBe(30);
  });
});

describe('상주 직원 · SAMPLE_ 계정 제외 (2026-10-13)', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 12, h));
  const NH = { latitude: 37.3900, longitude: 126.9500 };
  const rpt = (userId: string, lat: number, lng: number, h: number, res: { latitude: number; longitude: number } | null): MismatchPoint =>
    ({ userId, userName: userId, lat, lng, changedAt: t(h), status: 'HQ_WORKING', clientName: null, residentLat: res?.latitude ?? null, residentLng: res?.longitude ?? null });

  it('배정 고객사 근처에서 반복된 상주 직원 기록은 문제 장소에서 빼고 개수만 센다', () => {
    const pts = [rpt('a', 37.3920, 126.9500, 1, NH), rpt('b', 37.3921, 126.9501, 2, NH), rpt('c', 37.3919, 126.9499, 3, NH), rpt('d', 37.3920, 126.9502, 4, NH)];
    const r = classifyHotspots(clusterMismatchPoints(pts), [{ name: 'NH농협은행 의왕', latitude: 37.3900, longitude: 126.9500 }], { lat: 37.4, lng: 127.1 });
    expect(r.hotspots).toHaveLength(0);
    expect(r.residentAreaClusters).toBe(1);
  });
  it('상주 직원이 아닌 사람이 한 명이라도 섞여 있으면 그대로 후보로 남는다', () => {
    const pts = [rpt('a', 37.3920, 126.9500, 1, NH), rpt('b', 37.3921, 126.9501, 2, NH), rpt('x', 37.3919, 126.9499, 3, null)];
    const r = classifyHotspots(clusterMismatchPoints(pts), [{ name: 'NH농협은행 의왕', latitude: 37.3900, longitude: 126.9500 }], { lat: 37.4, lng: 127.1 });
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0].userCount).toBe(3);
    expect(r.residentAreaClusters).toBe(0);
  });
  it('배정 고객사가 이 장소와 멀면(다른 곳 상주) 제외하지 않는다', () => {
    const FAR = { latitude: 35.1, longitude: 129.0 };
    const pts = [rpt('a', 37.3920, 126.9500, 1, FAR), rpt('b', 37.3921, 126.9501, 2, FAR)];
    const r = classifyHotspots(clusterMismatchPoints(pts), [], null);
    expect(r.hotspots).toHaveLength(1);
    expect(r.residentAreaClusters).toBe(0);
  });

  describe('현장 기록 점검 라우트는 SAMPLE_ 계정을 조회에서 뺀다', () => {
    const fieldApp = express();
    const fr = createRouter();
    registerFieldCheckRoutes(fr);
    fieldApp.use('/attendance', fr);
    beforeEach(() => { Object.values(fns).forEach((m) => m.mockReset()); audit.mockClear(); });
    const hasFilter = (where: any) => JSON.stringify(where?.user) === JSON.stringify({ name: { not: { startsWith: 'SAMPLE_' } } });

    it('위치 예외 · 자동 종료 · 미입력 등 모든 조회에 SAMPLE_ 제외 조건이 붙는다', async () => {
      for (const k of ['statusChangeLog.findMany', 'attendanceRecord.findMany', 'effortLog.findMany', 'client.findMany', 'user.findMany', 'auditLog.findMany']) f(k).mockResolvedValue([]);
      const r = await request(fieldApp).get('/attendance/admin/field-check/exceptions');
      expect(r.status).toBe(200);
      const checked = ['statusChangeLog.findMany', 'attendanceRecord.findMany', 'effortLog.findMany'];
      for (const k of checked) {
        expect(f(k).mock.calls.length).toBeGreaterThan(0);
        for (const c of f(k).mock.calls) expect(hasFilter(c[0].where)).toBe(true);
      }
    });
    it('방문지 점검: 불일치 조회에 SAMPLE_ 제외 조건이 붙고, SAMPLE_ 계정이 낸 막힘 기록은 합계에서 뺀다', async () => {
      f('statusChangeLog.findMany').mockResolvedValue([]);
      f('auditLog.findMany').mockResolvedValue([
        { actorUserId: 'u1', afterValue: { kind: 'CLIENT', clientName: '메타온넷', distanceMeters: 900, phase: 'FIRST' } },
        { actorUserId: 'sys', afterValue: { kind: 'CLIENT', clientName: '메타온넷', distanceMeters: 900, phase: 'FIRST' } },
      ]);
      f('client.findMany').mockResolvedValue([]);
      f('user.findMany').mockResolvedValue([{ id: 'u1', name: '김' }, { id: 'sys', name: 'SAMPLE_시스템관리자' }]);
      const r = await request(fieldApp).get('/attendance/admin/field-check/location-hotspots');
      expect(r.status).toBe(200);
      expect(hasFilter(f('statusChangeLog.findMany').mock.calls[0][0].where)).toBe(true);
      expect(r.body.data.blocked.total).toBe(1);
      expect(r.body.data.residentAreaClusters).toBe(0);
    });
  });
});
