// 퇴근 정정 신청 때 업무일지 필수 + 지난 근무일 미퇴근 안내 문구 + 관리자 점검 API를 DB 없이 검증한다.
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
const upsertMock = jest.fn(async () => ({ id: 'log1', workDate: new Date('2026-10-12T00:00:00Z'), formType: 'SIMPLE' }));
jest.mock('../modules/daily-work-log/daily-work-log.routes', () => {
  const actual = jest.requireActual('../modules/daily-work-log/daily-work-log.routes');
  return { ...actual, upsertDailyWorkLog: (...a: any[]) => (upsertMock as any)(...a) };
});

import express from 'express';
import request from 'supertest';
import { attendanceCorrectionRouter } from '../modules/attendance-correction/attendance-correction.routes';
import { registerFieldCheckRoutes } from '../modules/attendance/field-check.routes';
import { createRouter } from '../common/async-router';
import { buildUnclosedPastReminderBody } from '../modules/push/reminder-scheduler';

const app = express();
app.use(express.json());
app.use('/attendance-correction', attendanceCorrectionRouter);
const fieldRouter = createRouter();
registerFieldCheckRoutes(fieldRouter);
app.use('/attendance', fieldRouter);

const RID = '11111111-1111-4111-8111-111111111111';
const f = (k: string) => fns[k] ?? (fns[k] = jest.fn(async () => null));

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'], now: new Date('2026-10-13T02:00:00Z') }); // 화 11:00 KST
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  Object.values(fns).forEach((m) => m.mockReset());
  for (const [key, m] of Object.entries(fns)) {
    const method = key.split('.')[1];
    m.mockImplementation(async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null));
  }
  upsertMock.mockClear();
  f('attendanceRecord.findUnique').mockResolvedValue({
    id: RID, userId: 'u1', workDate: new Date('2026-10-12T00:00:00Z'), clockInAt: new Date('2026-10-12T04:00:00Z'), clockOutAt: null,
  });
  f('attendanceCorrectionRequest.create').mockImplementation(async ({ data }: any) => ({ id: 'c1', ...data }));
  f('approvalRequest.create').mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
});

const body = (extra: any = {}) => ({
  attendanceRecordId: RID,
  proposedClockOutAt: '2026-10-12T11:00:00.000Z', // 20:00 KST — 자동승인 대상 아님
  reason: '퇴근 버튼 누르는 걸 깜빡했습니다.',
  ...extra,
});

describe('POST /attendance-correction/requests — 업무일지 필수', () => {
  test('그 날 일지가 없고 dailyWorkLog 도 없으면 WORK_LOG_REQUIRED 로 막고 신청은 생성되지 않는다', async () => {
    const res = await request(app).post('/attendance-correction/requests').send(body());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORK_LOG_REQUIRED');
    expect(res.body.error.message).toContain('업무일지');
    expect(f('attendanceCorrectionRequest.create')).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  test('내일 예정 업무가 "없음" 이면 글자 수 규칙 안내와 함께 막는다', async () => {
    const res = await request(app).post('/attendance-correction/requests').send(body({ dailyWorkLog: { issues: '특이사항 없음', tomorrowPlan: '없음' } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORK_LOG_REQUIRED');
    expect(res.body.error.message).toContain('3글자');
    expect(f('attendanceCorrectionRequest.create')).not.toHaveBeenCalled();
  });

  test('이슈/특이사항이 비면 막는다', async () => {
    const res = await request(app).post('/attendance-correction/requests').send(body({ dailyWorkLog: { issues: '  ', tomorrowPlan: '코스콤 점검' } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORK_LOG_REQUIRED');
    expect(res.body.error.message).toContain('이슈');
  });

  test('올바른 일지를 함께 보내면 일지를 저장하고(그 날 workDate) 정정 신청을 만든다', async () => {
    const res = await request(app).post('/attendance-correction/requests').send(body({ dailyWorkLog: { issues: '특이사항 없음', tomorrowPlan: '코스콤 서버 점검' } }));
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [uid, wd, input] = upsertMock.mock.calls[0] as any[];
    expect(uid).toBe('u1');
    expect(new Date(wd).toISOString().slice(0, 10)).toBe('2026-10-12');
    expect(input).toMatchObject({ issues: '특이사항 없음', tomorrowPlan: '코스콤 서버 점검', formType: 'SIMPLE' });
    expect(f('attendanceCorrectionRequest.create')).toHaveBeenCalled();
  });

  test('그 날 일지가 이미 있으면 일지 없이도 신청되고, 기존 일지는 건드리지 않는다', async () => {
    f('dailyWorkLog.findUnique').mockResolvedValue({ id: 'existing' });
    const res = await request(app).post('/attendance-correction/requests').send(body());
    expect(res.status).toBe(200);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(f('attendanceCorrectionRequest.create')).toHaveBeenCalled();
  });
});

describe('GET /attendance-correction/pending — hasWorkLog', () => {
  test('날짜별로 일지가 있는지 알려준다', async () => {
    f('attendanceRecord.findMany').mockResolvedValue([
      { id: 'r1', workDate: new Date('2026-10-12T00:00:00Z'), clockInAt: new Date('2026-10-12T04:00:00Z'), correctionRequests: [] },
      { id: 'r2', workDate: new Date('2026-10-09T00:00:00Z'), clockInAt: new Date('2026-10-09T04:00:00Z'), correctionRequests: [] },
    ]);
    f('dailyWorkLog.findMany').mockResolvedValue([{ workDate: new Date('2026-10-09T00:00:00Z') }]);
    const res = await request(app).get('/attendance-correction/pending');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => [r.attendanceRecordId, r.hasWorkLog])).toEqual([['r1', false], ['r2', true]]);
  });

  test('미퇴근 기록이 없으면 일지 조회 없이 빈 목록', async () => {
    const res = await request(app).get('/attendance-correction/pending');
    expect(res.body.data).toEqual([]);
    expect(f('dailyWorkLog.findMany')).not.toHaveBeenCalled();
  });
});

describe('GET /attendance/admin/field-check/attendance-gaps', () => {
  test('미퇴근(정정 신청 상태 포함)과 일지 없는 퇴근을 나눠서 돌려준다', async () => {
    f('attendanceRecord.findMany').mockImplementation(async (args: any) => {
      if (args.where.clockOutAt === null) {
        return [
          { id: 'u-a', userId: 'x1', workDate: new Date('2026-10-12T00:00:00Z'), clockInAt: new Date('2026-10-12T04:00:00Z'), dataSource: 'MANUAL', user: { name: '가' }, correctionRequests: [] },
          { id: 'u-b', userId: 'x2', workDate: new Date('2026-10-09T00:00:00Z'), clockInAt: new Date('2026-10-09T05:00:00Z'), dataSource: 'MANUAL', user: { name: '나' }, correctionRequests: [{ status: 'PENDING', createdAt: new Date('2026-10-10T01:00:00Z') }] },
        ];
      }
      return [
        { id: 'c-a', userId: 'x3', workDate: new Date('2026-10-08T00:00:00Z'), clockOutAt: new Date('2026-10-08T09:00:00Z'), isCorrected: true, user: { name: '다' } },
        { id: 'c-b', userId: 'x4', workDate: new Date('2026-10-08T00:00:00Z'), clockOutAt: new Date('2026-10-08T09:00:00Z'), isCorrected: false, user: { name: '라' } },
      ];
    });
    f('dailyWorkLog.findMany').mockResolvedValue([{ userId: 'x4', workDate: new Date('2026-10-08T00:00:00Z') }, { userId: 'x2', workDate: new Date('2026-10-09T00:00:00Z') }]);
    const res = await request(app).get('/attendance/admin/field-check/attendance-gaps');
    expect(res.status).toBe(200);
    expect(res.body.data.unclosed).toEqual([
      expect.objectContaining({ userName: '가', workDate: '2026-10-12', requestStatus: 'NONE', hasWorkLog: false }),
      expect.objectContaining({ userName: '나', workDate: '2026-10-09', requestStatus: 'PENDING', hasWorkLog: true }),
    ]);
    expect(res.body.data.noLog).toEqual([expect.objectContaining({ userName: '다', workDate: '2026-10-08', isCorrected: true })]);
    // 다우오피스 동기화분·SAMPLE·퇴사자는 조회 조건에서 제외된다
    const clockedOutCall = f('attendanceRecord.findMany').mock.calls.find((c: any[]) => c[0].where.clockOutAt?.not === null)!;
    expect(clockedOutCall[0].where.dataSource).toBe('MANUAL');
    expect(clockedOutCall[0].where.user).toMatchObject({ employmentStatus: 'ACTIVE' });
  });

  test('기간 형식이 틀리면 400', async () => {
    const res = await request(app).get('/attendance/admin/field-check/attendance-gaps?from=abc');
    expect(res.status).toBe(400);
  });
});

describe('지난 근무일 미퇴근 안내 문구', () => {
  test('한 건이면 날짜 하나, 여러 건이면 "외 N건"', () => {
    expect(buildUnclosedPastReminderBody([new Date('2026-10-09T00:00:00Z')])).toContain('(10/9)');
    const many = buildUnclosedPastReminderBody([new Date('2026-10-12T00:00:00Z'), new Date('2026-10-09T00:00:00Z'), new Date('2026-10-10T00:00:00Z')]);
    expect(many).toContain('(10/9 외 2건)');
    expect(many).toContain('지난 근무일 퇴근 정정');
  });
});
