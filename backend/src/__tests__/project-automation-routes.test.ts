// DB 없이 prisma를 가짜로 바꿔 "연결 안 된 공수 정리 / PM 일괄 지정 / 내 기본값" 라우트의 쓰기 규칙을 검증한다.
const tx: any = {
  project: { create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  effortLog: { updateMany: jest.fn() },
  projectMember: { createMany: jest.fn(), upsert: jest.fn() },
};
const mockPrisma: any = {
  user: { findMany: jest.fn() },
  client: { findMany: jest.fn() },
  project: { findMany: jest.fn(), findUnique: jest.fn() },
  effortLog: { groupBy: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(async (fn: any) => fn(tx)),
};
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../common/guards/auth', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
const audit = jest.fn();
jest.mock('../common/audit', () => ({ recordAuditLog: (...a: any[]) => audit(...a) }));

import { registerProjectAutomationRoutes } from '../modules/projects/project-automation.routes';

const PID = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function routes() {
  const h: Record<string, Function> = {};
  const reg = (m: string) => (path: string, ...fns: Function[]) => { h[`${m} ${path}`] = fns[fns.length - 1]; };
  registerProjectAutomationRoutes({ get: reg('GET'), post: reg('POST') });
  return h;
}
function res() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
const req = (body: any = {}) => ({ authUser: { userId: 'admin-1' }, body, query: {} });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findMany.mockResolvedValue([]);
  tx.project.create.mockResolvedValue({ id: PID, code: 'DSTI-0223' });
  tx.project.findMany.mockResolvedValue([]);
  tx.effortLog.updateMany.mockResolvedValue({ count: 2 });
  tx.projectMember.createMany.mockResolvedValue({ count: 1 });
});

describe('POST /unlinked/assign', () => {
  it('프로젝트/새 프로젝트를 둘 다 주거나 둘 다 안 주면 400', async () => {
    const h = routes()['POST /unlinked/assign'];
    let r = res(); await h(req({ names: ['코스콤'] }), r); expect(r.statusCode).toBe(400);
    r = res(); await h(req({ names: ['코스콤'], projectId: PID, create: { name: '코스콤 프로젝트' } }), r); expect(r.statusCode).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
  it('없는 프로젝트면 404', async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);
    const r = res(); await routes()['POST /unlinked/assign'](req({ names: ['코스콤'], projectId: PID }), r);
    expect(r.statusCode).toBe(404);
  });
  it('연결할 공수가 없으면 409(아무것도 만들지 않음)', async () => {
    mockPrisma.effortLog.findMany.mockResolvedValue([]);
    const r = res(); await routes()['POST /unlinked/assign'](req({ names: ['코스콤'], create: { name: '코스콤 프로젝트' } }), r);
    expect(r.statusCode).toBe(409);
    expect(tx.project.create).not.toHaveBeenCalled();
  });
  it('기존 프로젝트에 연결: 미연결(project_id null) 공수만 바꾸고 참여자를 추가한다', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: PID });
    mockPrisma.effortLog.findMany.mockResolvedValue([
      { id: 'e1', userId: U1, workDate: d('2026-10-01') }, { id: 'e2', userId: U1, workDate: d('2026-10-02') },
    ]);
    const r = res(); await routes()['POST /unlinked/assign'](req({ names: ['코스콤'], projectId: PID }), r);
    expect(r.body.data).toMatchObject({ projectId: PID, linked: 2, addedMembers: 1, createdCode: null });
    const upd = tx.effortLog.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ projectId: null });
    expect(upd.data).toEqual({ projectId: PID });
    expect(tx.project.create).not.toHaveBeenCalled();
    // 조회 조건에도 미연결/제외 작업유형이 들어 있다
    const find = mockPrisma.effortLog.findMany.mock.calls[0][0];
    expect(find.where.projectId).toBeNull();
    expect(find.where.workType.notIn).toEqual(expect.arrayContaining(['식사', '교육']));
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it('새 프로젝트로 연결: DSTI 코드로 만들고 시작일은 가장 이른 공수일', async () => {
    mockPrisma.effortLog.findMany.mockResolvedValue([
      { id: 'e1', userId: U1, workDate: d('2026-10-05') }, { id: 'e2', userId: U1, workDate: d('2026-09-01') },
    ]);
    tx.project.findMany.mockResolvedValue([{ code: 'DSTI-0222' }]);
    const r = res(); await routes()['POST /unlinked/assign'](req({ names: ['이상한이름'], create: { name: '신규 고객 프로젝트', clientId: null } }), r);
    const data = tx.project.create.mock.calls[0][0].data;
    expect(data.code).toBe('DSTI-0223');
    expect(data.status).toBe('ACTIVE');
    expect(data.startDate).toEqual(d('2026-09-01'));
    expect(r.body.data.createdCode).toBe('DSTI-0223');
  });
});

describe('POST /managers/apply-suggested', () => {
  it('confirm 없이는 실행하지 않는다', async () => {
    const r = res(); await routes()['POST /managers/apply-suggested'](req({}), r);
    expect(r.statusCode).toBe(400);
    expect(mockPrisma.project.findMany).not.toHaveBeenCalled();
  });
  it('PM이 비어 있는 프로젝트에만 공수 최다 엔지니어를 지정하고, 이미 지정된 경우(동시 변경)는 건드리지 않는다', async () => {
    mockPrisma.project.findMany.mockResolvedValue([{ id: 'pa' }, { id: 'pb' }]);
    mockPrisma.effortLog.groupBy.mockResolvedValue([
      { projectId: 'pa', userId: 'u1', _sum: { actualMinutes: 600, minutes: 650 }, _count: { _all: 3 }, _max: { workDate: d('2026-10-01') } },
      { projectId: 'pa', userId: 'u2', _sum: { actualMinutes: 60, minutes: 60 }, _count: { _all: 1 }, _max: { workDate: d('2026-10-02') } },
      { projectId: 'pb', userId: 'u2', _sum: { actualMinutes: 120, minutes: 120 }, _count: { _all: 1 }, _max: { workDate: d('2026-10-02') } },
    ]);
    mockPrisma.user.findMany.mockImplementation(async (args: any) => (args.where?.name ? [] : [{ id: 'u1', name: '갑' }, { id: 'u2', name: '을' }]));
    tx.project.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const r = res(); await routes()['POST /managers/apply-suggested'](req({ confirm: true }), r);
    expect(r.body.data).toEqual({ candidates: 2, withSuggestion: 2, updated: 1 });
    const first = tx.project.updateMany.mock.calls[0][0];
    expect(first.where).toEqual({ id: 'pa', managerId: null });
    expect(first.data).toEqual({ managerId: 'u1' });
    expect(tx.projectMember.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('GET /my-defaults', () => {
  it('본인 기록만 최근 120일 범위로 조회한다', async () => {
    mockPrisma.effortLog.findMany.mockResolvedValue([{ clientName: '코스콤', workType: '정기점검', projectId: 'p1', sourceStatus: 'CLIENT_WORK', description: 'x' }]);
    const r = res(); await routes()['GET /my-defaults']({ authUser: { userId: U1 }, query: {} }, r);
    const where = mockPrisma.effortLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(U1);
    expect(Date.now() - where.workDate.gte.getTime()).toBeGreaterThan(119 * 86400_000);
    expect(r.body.data).toEqual([{ clientName: '코스콤', workType: '정기점검', projectId: 'p1' }]);
  });
});
