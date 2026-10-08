// DB 없이 prisma를 가짜로 바꿔 프로젝트 코드 채번(DSTI-)과 통합 화면용 조회 API의 입력 검증/집계를 검증한다.
const mockPrisma: any = {
  effortLog: { groupBy: jest.fn(), count: jest.fn(), aggregate: jest.fn(), findMany: jest.fn() },
  user: { findMany: jest.fn() },
  dailyWorkLog: { findMany: jest.fn() },
};
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../common/guards/auth', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));

import { nextProjectCode, PROJECT_CODE_PREFIX } from '../modules/projects/project-code';
import { registerProjectInsightRoutes } from '../modules/projects/project-insights.routes';

const PID = '11111111-1111-4111-8111-111111111111';
const UID = '22222222-2222-4222-8222-222222222222';

function makeRouter() {
  const handlers: Record<string, Function> = {};
  registerProjectInsightRoutes({ get: (path: string, _guard: any, fn: Function) => { handlers[path] = fn; } });
  return handlers;
}
function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeEach(() => { jest.clearAllMocks(); });

describe('nextProjectCode', () => {
  it('접두어는 DSTI-', () => expect(PROJECT_CODE_PREFIX).toBe('DSTI-'));
  it('기존 코드가 없으면 DSTI-0001', async () => {
    expect(await nextProjectCode({ project: { findMany: async () => [] } })).toBe('DSTI-0001');
  });
  it('가장 큰 숫자 코드 + 1 (숫자가 아닌 코드는 무시)', async () => {
    const rows = [{ code: 'DSTI-0221' }, { code: 'DSTI-CUSTOM' }, { code: 'DSTI-0009' }];
    expect(await nextProjectCode({ project: { findMany: async () => rows } })).toBe('DSTI-0222');
  });
  it('4자리를 넘어도 이어서 채번', async () => {
    expect(await nextProjectCode({ project: { findMany: async () => [{ code: 'DSTI-9999' }] } })).toBe('DSTI-10000');
  });
});

describe('GET /:id/effort 입력 검증', () => {
  const h = makeRouter()['/:id/effort'];
  it('프로젝트 id가 UUID가 아니면 404', async () => {
    const res = makeRes();
    await h({ params: { id: 'x' }, query: {} }, res);
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.effortLog.findMany).not.toHaveBeenCalled();
  });
  it('날짜 형식이 틀리면 400', async () => {
    const res = makeRes();
    await h({ params: { id: PID }, query: { from: '2026/10/01' } }, res);
    expect(res.statusCode).toBe(400);
  });
  it('엔지니어 id가 UUID가 아니면 400', async () => {
    const res = makeRes();
    await h({ params: { id: PID }, query: { userId: "x' OR 1=1" } }, res);
    expect(res.statusCode).toBe(400);
  });
  it('필터/페이징을 where·skip·take로 전달하고 pageSize는 100으로 제한', async () => {
    mockPrisma.effortLog.count.mockResolvedValue(1);
    mockPrisma.effortLog.aggregate.mockResolvedValue({ _sum: { actualMinutes: 90, minutes: 100 } });
    mockPrisma.effortLog.findMany.mockResolvedValue([
      { id: 'e1', workDate: d('2026-10-05'), workType: '정기점검', clientName: '코스콤', minutes: 100, actualMinutes: 90, startTime: new Date(), endTime: null, description: 'x', sourceStatus: 'CLIENT_WORK', user: { id: UID, name: '홍길동' }, task: null },
    ]);
    const res = makeRes();
    await h({ params: { id: PID }, query: { from: '2026-10-01', to: '2026-10-31', userId: UID, page: '2', pageSize: '999' } }, res);
    const arg = mockPrisma.effortLog.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ projectId: PID, userId: UID, workDate: { gte: d('2026-10-01'), lte: d('2026-10-31') } });
    expect(arg.skip).toBe(100);
    expect(arg.take).toBe(100);
    expect(res.body.data.totalMinutes).toBe(90);
    expect(res.body.data.rows[0]).toMatchObject({ workDate: '2026-10-05', userName: '홍길동', minutes: 90, inProgress: true, taskTitle: null });
  });
});

describe('GET /:id/summary', () => {
  const h = makeRouter()['/:id/summary'];
  it('엔지니어별·월별로 합산하고 실공수(actualMinutes)를 우선 사용', async () => {
    mockPrisma.effortLog.groupBy
      .mockResolvedValueOnce([
        { userId: UID, _sum: { actualMinutes: 300, minutes: 320 }, _count: { _all: 3 }, _max: { workDate: d('2026-09-20') } },
      ])
      .mockResolvedValueOnce([
        { workDate: d('2026-08-31'), _sum: { actualMinutes: null, minutes: 60 }, _count: { _all: 1 } },
        { workDate: d('2026-09-01'), _sum: { actualMinutes: 120, minutes: 130 }, _count: { _all: 1 } },
        { workDate: d('2026-09-20'), _sum: { actualMinutes: 120, minutes: 130 }, _count: { _all: 1 } },
      ]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: UID, name: '홍길동' }]);
    const res = makeRes();
    await h({ params: { id: PID }, query: {} }, res);
    expect(res.body.data.totalMinutes).toBe(300);
    expect(res.body.data.totalLogs).toBe(3);
    expect(res.body.data.lastActivityDate).toBe('2026-09-20');
    expect(res.body.data.byMonth).toEqual([{ month: '2026-08', minutes: 60, logCount: 1 }, { month: '2026-09', minutes: 240, logCount: 2 }]);
    expect(res.body.data.byEngineer[0]).toMatchObject({ name: '홍길동', minutes: 300, logCount: 3, lastDate: '2026-09-20' });
  });
  it('공수가 없어도 빈 결과를 돌려준다', async () => {
    mockPrisma.effortLog.groupBy.mockResolvedValue([]);
    const res = makeRes();
    await h({ params: { id: PID }, query: {} }, res);
    expect(res.body.data).toMatchObject({ totalMinutes: 0, totalLogs: 0, lastActivityDate: null, byEngineer: [], byMonth: [] });
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /:id/daily-logs', () => {
  const h = makeRouter()['/:id/daily-logs'];
  it('(엔지니어,날짜)별로 합치고 일지가 없는 날은 hasLog=false', async () => {
    mockPrisma.effortLog.findMany.mockResolvedValue([
      { userId: UID, workDate: d('2026-10-05'), minutes: 60, actualMinutes: 50 },
      { userId: UID, workDate: d('2026-10-05'), minutes: 60, actualMinutes: null },
      { userId: UID, workDate: d('2026-10-04'), minutes: 30, actualMinutes: 30 },
    ]);
    mockPrisma.dailyWorkLog.findMany.mockResolvedValue([
      { userId: UID, workDate: d('2026-10-05'), workContent: '점검', issues: '없음', tomorrowPlan: '복귀', followUp: null, supportRequest: null, visitedClients: '코스콤', totalWorkedMinutes: 480 },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: UID, name: '홍길동' }]);
    const res = makeRes();
    await h({ params: { id: PID }, query: {} }, res);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.rows[0]).toMatchObject({ workDate: '2026-10-05', projectMinutes: 110, hasLog: true, workContent: '점검' });
    expect(res.body.data.rows[1]).toMatchObject({ workDate: '2026-10-04', hasLog: false, workContent: null });
  });
  it('잘못된 조건은 400', async () => {
    const res = makeRes();
    await h({ params: { id: PID }, query: { to: 'abc' } }, res);
    expect(res.statusCode).toBe(400);
  });
});
