// GET /daily-work-log/draft(표준 형식·제안 칩)와 GET /attendance/admin/field-check/work-log-quality(업무일지 점검)를 DB 없이 검증한다.
jest.mock('../common/policy-engine/policy-engine', () => ({
  getPolicyNumber: async (_k: string, f: number) => f,
  getPolicyString: async (_k: string, f: string) => f,
  getPolicyBoolean: async (_k: string, f: boolean) => f,
  getPolicyJSON: async (_k: string, f: any) => f,
}));
const fns: Record<string, jest.Mock> = {};
function model(name: string) {
  return new Proxy({}, {
    get(_t, method: string) {
      const key = `${name}.${method}`;
      if (!fns[key]) fns[key] = jest.fn(async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null));
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

import express from 'express';
import request from 'supertest';
import { dailyWorkLogRouter } from '../modules/daily-work-log/daily-work-log.routes';
import { registerFieldCheckRoutes } from '../modules/attendance/field-check.routes';
import { createRouter } from '../common/async-router';

const app = express();
app.use(express.json());
app.use('/daily-work-log', dailyWorkLogRouter);
const fieldRouter = createRouter();
registerFieldCheckRoutes(fieldRouter);
app.use('/attendance', fieldRouter);

const f = (k: string) => fns[k] ?? (fns[k] = jest.fn(async () => null));
const set = (k: string, v: any) => f(k).mockImplementation(async () => v);

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'], now: new Date('2026-10-15T09:00:00Z') });
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  Object.values(fns).forEach((m) => m.mockReset());
  for (const [key, m] of Object.entries(fns)) {
    const method = key.split('.')[1];
    m.mockImplementation(async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null));
  }
});

describe('GET /daily-work-log/draft', () => {
  it('작업내용을 표준 형식으로 만들고 제안 칩과 설명 누락 건수를 내려준다', async () => {
    set('statusChangeLog.findMany', [{ status: 'CLIENT_WORK', changedAt: new Date('2026-10-15T00:30:00Z') }]);
    set('effortLog.findMany', [
      { clientName: '코스콤', projectName: '정기점검', workType: '장애대응', startTime: new Date('2026-10-15T00:30:00Z'), endTime: new Date('2026-10-15T03:10:00Z'), minutes: 160, actualMinutes: 160, description: '서버 복구', contactName: '김담당', taskId: null },
      { clientName: '코스콤', projectName: '정기점검', workType: '정기점검', startTime: new Date('2026-10-15T04:30:00Z'), endTime: null, minutes: null, actualMinutes: null, description: null, contactName: null, taskId: null },
    ]);
    set('projectTask.findMany', [{ id: 't1', title: '방화벽 룰 정리', status: 'IN_PROGRESS', dueDate: new Date('2026-10-20T00:00:00Z'), project: { name: '코스콤 보안강화' } }]);
    const res = await request(app).get('/daily-work-log/draft?workDate=2026-10-15');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.formType).toBe('DETAILED');
    expect(d.workContent).toContain('■ 코스콤 · 정기점검');
    expect(d.workContent).toContain('- 09:30~12:10 (2시간 40분) · 장애대응 · 담당 김담당');
    expect(d.workContent).toContain('  → 서버 복구');
    expect(d.workContent).toContain('- 13:30~진행중 · 정기점검');
    expect(d.missingDescriptionCount).toBe(1);
    expect(d.suggestions.issues[0].text).toBe('코스콤 장애대응(09:30) 처리 — 원인/조치: ');
    expect(d.suggestions.followUp.map((x: any) => x.text)).toEqual(expect.arrayContaining(['코스콤 장애 처리 후 재발 여부 모니터링', '코스콤 정기점검 잔여 작업 마무리 필요']));
    expect(d.suggestions.tomorrowPlan.map((x: any) => x.text)).toEqual(expect.arrayContaining(['코스콤 정기점검 정기점검 이어서 진행', '코스콤 보안강화 · 방화벽 룰 정리 (기한 10/20) 진행']));
    // Task 조회는 본인 배정 + 미완료 + 진행 가능한 프로젝트만.
    const where = f('projectTask.findMany').mock.calls[0][0].where;
    expect(where.assigneeId).toBe('u1');
    expect(where.status.in).toEqual(['TODO', 'IN_PROGRESS']);
  });

  it('기록이 없는 날도 오류 없이 빈 초안과 "특이사항 없음" 제안만 준다', async () => {
    const res = await request(app).get('/daily-work-log/draft?workDate=2026-10-15');
    expect(res.status).toBe(200);
    expect(res.body.data.workContent).toBeNull();
    expect(res.body.data.missingDescriptionCount).toBe(0);
    expect(res.body.data.suggestions.issues.map((x: any) => x.text)).toEqual(['특이사항 없음']);
    expect(res.body.data.suggestions.tomorrowPlan).toEqual([]);
  });
});

describe('GET /attendance/admin/field-check/work-log-quality', () => {
  it('일지·퇴근 기록·작업 기록을 모아 작성률과 점수를 계산한다', async () => {
    const user = { name: '홍길동', department: { name: '기술지원팀' } };
    set('dailyWorkLog.findMany', [
      { userId: 'u1', workDate: new Date('2026-10-13T00:00:00Z'), formType: 'SIMPLE', visitedClients: null, workContent: null, issues: '특이사항 없음', tomorrowPlan: '코스콤 서버 점검', actualEffortMinutes: null, user },
      { userId: 'u1', workDate: new Date('2026-10-14T00:00:00Z'), formType: 'SIMPLE', visitedClients: null, workContent: null, issues: '.', tomorrowPlan: '없음', actualEffortMinutes: null, user },
    ]);
    set('attendanceRecord.findMany', [
      { userId: 'u1', workDate: new Date('2026-10-13T00:00:00Z'), clockOutAt: new Date('2026-10-13T09:00:00Z'), user },
      { userId: 'u1', workDate: new Date('2026-10-14T00:00:00Z'), clockOutAt: new Date('2026-10-14T09:00:00Z'), user },
      { userId: 'u1', workDate: new Date('2026-10-12T00:00:00Z'), clockOutAt: new Date('2026-10-12T09:00:00Z'), user },
      { userId: 'u1', workDate: new Date('2026-10-15T00:00:00Z'), clockOutAt: null, user }, // 아직 퇴근 전
    ]);
    set('client.findMany', [{ name: '코스콤' }]);
    const res = await request(app).get('/attendance/admin/field-check/work-log-quality?from=2026-10-12&to=2026-10-15');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.from).toBe('2026-10-12');
    expect(d.totals.completedDays).toBe(3);
    expect(d.totals.logDays).toBe(2);
    expect(d.totals.coverageRate).toBe(66.7);
    expect(d.users[0].missingDates).toEqual(['2026-10-12']);
    expect(d.byFlag.map((x: any) => x.flag)).toEqual(expect.arrayContaining(['PLAN_WEAK', 'ISSUES_JUNK']));
    // SAMPLE_ 계정·퇴직자 제외 조건과 다우오피스 동기화분 제외 조건이 조회에 들어가야 한다.
    const attWhere = f('attendanceRecord.findMany').mock.calls[0][0].where;
    expect(attWhere.dataSource).toBe('MANUAL');
    expect(attWhere.user.employmentStatus).toBe('ACTIVE');
    expect(attWhere.user.name).toEqual({ not: { startsWith: 'SAMPLE_' } });
  });

  it('기간 형식이 틀리면 400', async () => {
    const res = await request(app).get('/attendance/admin/field-check/work-log-quality?from=abc&to=2026-10-15');
    expect(res.status).toBe(400);
  });

  it('데이터가 없어도 빈 요약을 돌려준다', async () => {
    const res = await request(app).get('/attendance/admin/field-check/work-log-quality?from=2026-10-12&to=2026-10-15');
    expect(res.status).toBe(200);
    expect(res.body.data.totals.coverageRate).toBeNull();
    expect(res.body.data.users).toEqual([]);
  });
});
