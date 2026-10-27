// 업무일지 AI 보조(마스킹·프롬프트·응답 검증·사용량 제한·호출 경로)를 외부 호출 없이 검증한다.
import {
  isAiAssistEnabled, aiModel, aiDailyLimit, maskSensitive, buildPolishRequest, buildVoiceRequest, parseAiJson, sanitizeResult,
  callClaude, AiError, UsageLimiter, MIN_INTERVAL_MS, DEFAULT_MODEL,
} from '../modules/daily-work-log/ai-assist';

describe('설정', () => {
  it('AI_ASSIST_ENABLED=1 과 API 키가 모두 있어야 켜진다(기본 꺼짐)', () => {
    expect(isAiAssistEnabled({})).toBe(false);
    expect(isAiAssistEnabled({ AI_ASSIST_ENABLED: '1' })).toBe(false);
    expect(isAiAssistEnabled({ ANTHROPIC_API_KEY: 'k' })).toBe(false);
    expect(isAiAssistEnabled({ AI_ASSIST_ENABLED: '1', ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(isAiAssistEnabled({ AI_ASSIST_ENABLED: 'true', ANTHROPIC_API_KEY: 'k' })).toBe(false);
    expect(isAiAssistEnabled({ AI_ASSIST_ENABLED: '1', ANTHROPIC_API_KEY: 'k' })).toBe(true);
  });
  it('모델과 하루 한도는 환경변수로 바꿀 수 있고 기본값이 있다', () => {
    expect(aiModel({})).toBe(DEFAULT_MODEL);
    expect(aiModel({ AI_ASSIST_MODEL: 'x-model' })).toBe('x-model');
    expect(aiDailyLimit({})).toBe(30);
    expect(aiDailyLimit({ AI_ASSIST_DAILY_LIMIT: '5' })).toBe(5);
    expect(aiDailyLimit({ AI_ASSIST_DAILY_LIMIT: 'abc' })).toBe(30);
  });
});

describe('maskSensitive', () => {
  it('이메일·링크·전화번호·IP·주민번호 형태·긴 숫자를 가린다', () => {
    const t = '담당 kim@corp.co.kr 연락 010-1234-5678, 02-345-6789, 서버 10.1.2.30 접속 https://x.com/a?b=1 번호 900101-1234567 계좌 123456789012';
    const m = maskSensitive(t);
    expect(m).not.toMatch(/kim@corp|010-1234|02-345|10\.1\.2\.30|https:|900101|123456789012/);
    expect(m).toContain('[이메일]');
    expect(m).toContain('[전화번호]');
    expect(m).toContain('[IP]');
    expect(m).toContain('[링크]');
  });
  it('일반 문장·시각·소량 숫자는 그대로 둔다', () => {
    const t = '코스콤 서버 3대 디스크 85% 점검, 13:30 완료';
    expect(maskSensitive(t)).toBe(t);
  });
});

describe('프롬프트', () => {
  it('polish는 입력한 칸만 요청하고 민감값을 가려서 보낸다', () => {
    const r = buildPolishRequest({ issues: '디스크 교체 010-1111-2222', tomorrowPlan: '' });
    expect(r.user).toContain('디스크 교체 [전화번호]');
    expect(r.user).not.toContain('010-1111-2222');
    expect(r.system).toContain('"issues"');
    expect(r.system).not.toContain('"tomorrowPlan"');
    expect(r.system).toContain('지어내지');
  });
  it('voice는 오늘 방문 고객사명만 참고로 붙이고 입력을 데이터로 감싼다', () => {
    const r = buildVoiceRequest('코스콤 점검 끝났고 내일 이어서 합니다', ['코스콤', '농협']);
    expect(r.user).toContain('오늘 방문 고객사(참고용): 코스콤, 농협');
    expect(r.user).toContain('<입력>');
    expect(r.system).toContain('따르지 않는다');
    expect(buildVoiceRequest('내용 있는 메모입니다', []).user).toContain('고객사 정보 없음');
  });
});

describe('parseAiJson', () => {
  it('앞뒤에 설명이나 코드블록이 붙어도 JSON만 꺼낸다', () => {
    expect(parseAiJson('```json\n{"issues":"A","tomorrowPlan":"B"}\n```')).toEqual({ issues: 'A', tomorrowPlan: 'B' });
  });
  it('깨진 JSON·배열·문자열이 아닌 값·해당 키 없음은 null', () => {
    expect(parseAiJson('죄송합니다')).toBeNull();
    expect(parseAiJson('{"issues": 1}')).toBeNull();
    expect(parseAiJson('[1,2]')).toBeNull();
    expect(parseAiJson('{"other":"x"}')).toBeNull();
    expect(parseAiJson('{"issues": "x"')).toBeNull();
  });
  it('모르는 키는 무시하고 너무 긴 값은 자른다', () => {
    const r = parseAiJson(JSON.stringify({ issues: 'a'.repeat(5000), hack: 'x' }))!;
    expect(r.issues!.length).toBe(1500);
    expect((r as any).hack).toBeUndefined();
  });
});

describe('sanitizeResult', () => {
  it('polish: 직원이 적지 않은 칸·원문과 같은 칸은 뺀다', () => {
    const out = sanitizeResult({ issues: '디스크 교체함', followUp: '새로 지어낸 후속조치', tomorrowPlan: '코스콤 서버 점검 이어서 진행' }, 'polish', { issues: '디스크 교체', followUp: '', tomorrowPlan: '코스콤 서버 점검 이어서 진행' });
    expect(out).toEqual({ issues: '디스크 교체함' });
  });
  it('내일 예정 업무가 규칙(3글자 이상 등)에 맞지 않으면 버린다', () => {
    expect(sanitizeResult({ tomorrowPlan: '없음' }, 'voice', {})).toEqual({});
    expect(sanitizeResult({ tomorrowPlan: '휴가' }, 'voice', {})).toEqual({ tomorrowPlan: '휴가' });
  });
  it('이슈가 의미 없는 값이면 버리고 "특이사항 없음"은 받는다', () => {
    expect(sanitizeResult({ issues: '.' }, 'voice', {})).toEqual({});
    expect(sanitizeResult({ issues: '특이사항 없음' }, 'voice', {})).toEqual({ issues: '특이사항 없음' });
  });
  it('voice: 세 칸을 모두 채울 수 있다', () => {
    const r = sanitizeResult({ issues: '디스크 교체 완료', followUp: '교체 후 모니터링', tomorrowPlan: '코스콤 점검 이어서 진행' }, 'voice', {});
    expect(Object.keys(r)).toEqual(['issues', 'followUp', 'tomorrowPlan']);
  });
});

describe('callClaude', () => {
  const ok = (text: string) => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) });
  const base = { apiKey: 'sk-test', model: 'm', system: 's', user: 'u' };

  it('올바른 주소·헤더·본문으로 호출하고 텍스트 블록을 돌려준다', async () => {
    const fetchImpl = jest.fn(ok('{"issues":"x"}'));
    await expect(callClaude({ ...base, fetchImpl })).resolves.toBe('{"issues":"x"}');
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('m');
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
    expect(body.system).toBe('s');
  });
  it('HTTP 오류·빈 응답·네트워크 오류를 구분해서 던진다', async () => {
    await expect(callClaude({ ...base, fetchImpl: async () => ({ ok: false, status: 429 }) })).rejects.toMatchObject({ code: 'AI_HTTP', httpStatus: 429 });
    await expect(callClaude({ ...base, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [] }) }) })).rejects.toMatchObject({ code: 'AI_BAD_RESPONSE' });
    await expect(callClaude({ ...base, fetchImpl: async () => { throw new Error('ECONNRESET'); } })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });
  it('시간 초과는 AI_TIMEOUT', async () => {
    const fetchImpl = (_u: string, init: any) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => { const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    await expect(callClaude({ ...base, fetchImpl, timeoutMs: 20 })).rejects.toBeInstanceOf(AiError);
    await expect(callClaude({ ...base, fetchImpl, timeoutMs: 20 })).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });
});

describe('UsageLimiter', () => {
  it('연속 호출은 최소 간격을 두고, 하루 한도를 넘으면 막고, 다음 날 초기화된다', () => {
    const l = new UsageLimiter();
    const t0 = Date.UTC(2026, 9, 15, 1, 0, 0);
    expect(l.check('u1', 2, t0)).toBe('OK');
    l.record('u1', t0);
    expect(l.check('u1', 2, t0 + 500)).toBe('TOO_FAST');
    expect(l.check('u1', 2, t0 + MIN_INTERVAL_MS + 1)).toBe('OK');
    l.record('u1', t0 + 3000);
    expect(l.check('u1', 2, t0 + 10_000)).toBe('LIMIT');
    expect(l.check('u2', 2, t0 + 10_000)).toBe('OK'); // 다른 직원은 별개
    expect(l.check('u1', 2, t0 + 24 * 3600_000)).toBe('OK'); // 다음 날
  });
});
