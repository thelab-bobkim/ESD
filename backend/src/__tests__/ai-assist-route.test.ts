// POST /daily-work-log/ai-assist 와 /draft 의 aiAssistEnabled 를 DB·외부 호출 없이 검증한다.
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
  requireAuth: (req: any, _res: any, next: any) => { req.authUser = { userId: req.headers['x-test-user'] ?? 'u1', roles: ['EMPLOYEE'] }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
const auditMock: jest.Mock = jest.fn(async (..._a: any[]) => undefined);
jest.mock('../common/audit', () => ({ recordAuditLog: (...a: any[]) => (auditMock as any)(...a) }));

import express from 'express';
import request from 'supertest';
import { dailyWorkLogRouter } from '../modules/daily-work-log/daily-work-log.routes';
import { aiUsageLimiter } from '../modules/daily-work-log/ai-assist';

const app = express();
app.use(express.json());
app.use('/daily-work-log', dailyWorkLogRouter);

const claudeReply = (obj: any) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) });
let fetchMock: jest.Mock;
const realFetch = (globalThis as any).fetch;

beforeEach(() => {
  Object.values(fns).forEach((m) => m.mockReset());
  for (const [key, m] of Object.entries(fns)) {
    const method = key.split('.')[1];
    m.mockImplementation(async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null));
  }
  auditMock.mockClear();
  aiUsageLimiter.reset();
  process.env.AI_ASSIST_ENABLED = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  delete process.env.AI_ASSIST_DAILY_LIMIT;
  fetchMock = jest.fn(async () => claudeReply({ issues: '디스크 교체 완료' }));
  (globalThis as any).fetch = fetchMock;
});
afterAll(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.AI_ASSIST_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('기본 꺼짐', () => {
  it('설정이 없으면 503 AI_DISABLED 이고 외부 호출을 하지 않는다', async () => {
    delete process.env.AI_ASSIST_ENABLED;
    const res = await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish', issues: '디스크 교체' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('/draft 는 aiAssistEnabled 로 켜짐 여부를 알려준다', async () => {
    expect((await request(app).get('/daily-work-log/draft?workDate=2026-10-15')).body.data.aiAssistEnabled).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect((await request(app).get('/daily-work-log/draft?workDate=2026-10-15')).body.data.aiAssistEnabled).toBe(false);
  });
});

describe('polish', () => {
  it('다듬은 제안만 돌려주고 저장하지 않으며 민감값은 가려서 보낸다', async () => {
    const res = await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish', issues: '디스크 교체 010-1234-5678', tomorrowPlan: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual({ issues: '디스크 교체 완료' });
    expect(res.body.data.changed).toBe(1);
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(JSON.stringify(sent)).not.toContain('010-1234-5678');
    expect(JSON.stringify(sent)).toContain('[전화번호]');
    expect(f('dailyWorkLog.upsert')).not.toHaveBeenCalled();
  });
  it('적은 내용이 없으면 400, 입력 형식이 틀려도 400', async () => {
    expect((await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish' })).body.error.code).toBe('NOTHING_TO_POLISH');
    expect((await request(app).post('/daily-work-log/ai-assist').send({ mode: 'bad' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('규칙에 안 맞는 결과(내일 예정 "없음")는 버린다', async () => {
    fetchMock.mockImplementation(async () => claudeReply({ tomorrowPlan: '없음' }));
    const res = await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish', tomorrowPlan: '코스콤 점검 이어서' });
    expect(res.body.data.suggestions).toEqual({});
    expect(res.body.data.changed).toBe(0);
  });
});

describe('voice', () => {
  it('말/메모를 세 칸으로 나누고 오늘 방문 고객사명을 참고로만 붙인다', async () => {
    f('effortLog.findMany').mockImplementation(async () => [{ clientName: '코스콤' }, { clientName: '코스콤' }]);
    fetchMock.mockImplementation(async () => claudeReply({ issues: '특이사항 없음', followUp: '', tomorrowPlan: '코스콤 서버 점검 이어서 진행' }));
    const res = await request(app).post('/daily-work-log/ai-assist').send({ mode: 'voice', transcript: '오늘 코스콤 점검 끝났고 내일 이어서 합니다' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual({ issues: '특이사항 없음', tomorrowPlan: '코스콤 서버 점검 이어서 진행' });
    const user = JSON.parse((fetchMock.mock.calls[0] as any)[1].body).messages[0].content;
    expect(user).toContain('오늘 방문 고객사(참고용): 코스콤');
  });
  it('너무 짧은 메모는 400', async () => {
    expect((await request(app).post('/daily-work-log/ai-assist').send({ mode: 'voice', transcript: '네' })).status).toBe(400);
  });
});

describe('실패·제한', () => {
  it('AI가 실패하면 502와 직접 입력 안내를 주고 퇴근을 막지 않는 문구를 쓴다', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const res = await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish', issues: '디스크 교체' });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('직접 입력');
  });
  it('JSON이 아닌 응답도 502', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '죄송합니다' }] }) }));
    expect((await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish', issues: '디스크 교체' })).status).toBe(502);
  });
  it('연속 호출은 429(AI_TOO_FAST), 하루 한도를 넘으면 429(AI_LIMIT)', async () => {
    const body = { mode: 'polish', issues: '디스크 교체' };
    expect((await request(app).post('/daily-work-log/ai-assist').send(body)).status).toBe(200);
    expect((await request(app).post('/daily-work-log/ai-assist').send(body)).body.error.code).toBe('AI_TOO_FAST');
    process.env.AI_ASSIST_DAILY_LIMIT = '1';
    aiUsageLimiter.reset();
    aiUsageLimiter.record('u9', Date.now() - 10_000);
    const res = await request(app).post('/daily-work-log/ai-assist').set('x-test-user', 'u9').send(body);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AI_LIMIT');
  });
  it('감사로그에는 사용 사실(모드·성공 여부)만 남기고 일지 내용은 남기지 않는다', async () => {
    await request(app).post('/daily-work-log/ai-assist').send({ mode: 'polish', issues: '비밀스러운 디스크 교체 내용' });
    const call = (auditMock.mock.calls as any[][]).find((c) => c[0]?.targetType === 'ai_assist')![0] as any;
    expect(call.afterValue).toEqual({ mode: 'polish', ok: true });
    expect(JSON.stringify(call)).not.toContain('비밀스러운');
  });
});

function f(k: string) { return fns[k] ?? (fns[k] = jest.fn(async () => null)); }
