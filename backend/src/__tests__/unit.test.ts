import { todayDateOnly, realDayWindow, isWeekendForWorkDate, lunchOverlapMinutes, combineDateTime, resolveEndTime } from '../common/attendance-helpers';
import { checkLocationMatch } from '../common/location';
import { createRouter, isAsyncWrapped } from '../common/async-router';

// ─────────────────────────────────────────────────────────────────────────────
// H-4: 프론트의 주말 판정이 서버(근무일 3시 경계)와 일치하는지 — 순수 함수 비교
// ─────────────────────────────────────────────────────────────────────────────
function serverWeekend(now: Date): boolean {
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  const wd = new Date(Date.UTC(kstShifted.getUTCFullYear(), kstShifted.getUTCMonth(), kstShifted.getUTCDate()));
  const d = wd.getUTCDay();
  return d === 0 || d === 6;
}
/** 수정 전 프론트: 자정 기준 달력요일 */
function oldFrontendWeekend(now: Date): boolean {
  const d = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCDay();
  return d === 0 || d === 6;
}
/** 수정 후 프론트: 근무일(3시 경계) 기준 */
function newFrontendWeekend(now: Date): boolean {
  const d = new Date(now.getTime() + 6 * 60 * 60 * 1000).getUTCDay();
  return d === 0 || d === 6;
}

describe('H-4 주말 판정 정합성', () => {
  it('수정 전 프론트 공식은 토요일 00~03시에 서버와 어긋난다(등록 불가 상태를 만들던 원인)', () => {
    const t = new Date('2026-10-02T16:00:00Z'); // 2026-10-03(토) 01:00 KST
    expect(oldFrontendWeekend(t)).toBe(true);   // 옛 화면: 주말 → 주말작업만 남기고 전부 잠금
    expect(serverWeekend(t)).toBe(false);       // 서버: 근무일은 아직 금요일 → 평일 규칙
    // 화면이 남긴 유일한 아이콘("주말작업")을 서버가 거부 → 어떤 상태도 등록 불가
  });

  it('수정 후 프론트 공식은 서버와 항상 일치한다(1년치 5분 간격 전수 비교)', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365 * 24 * 12; i++) {
      const t = new Date(start + i * 5 * 60 * 1000);
      expect(newFrontendWeekend(t)).toBe(serverWeekend(t));
    }
  });

  it('서버 함수 isWeekendForWorkDate도 같은 결론을 낸다', () => {
    const t = new Date('2026-10-02T16:00:00Z'); // 토 01:00 KST → 근무일은 금요일
    const workDate = new Date(Date.UTC(2026, 9, 2)); // 2026-10-02(금)
    expect(isWeekendForWorkDate(workDate)).toBe(false);
    const sunday = new Date(Date.UTC(2026, 9, 4));
    expect(isWeekendForWorkDate(sunday)).toBe(true);
    expect(serverWeekend(t)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 근무일 경계(새벽 3시) 헬퍼
// ─────────────────────────────────────────────────────────────────────────────
describe('근무일 경계(새벽 3시 KST)', () => {
  it('realDayWindow는 3시 경계 기준 [전날 18:00Z, 당일 18:00Z) 를 돌려준다', () => {
    const label = new Date(Date.UTC(2026, 8, 30));
    const { start, end } = realDayWindow(label);
    expect(start.toISOString()).toBe('2026-09-29T18:00:00.000Z'); // = KST 09-30 03:00
    expect(end.toISOString()).toBe('2026-09-30T18:00:00.000Z');   // = KST 10-01 03:00
  });

  it('combineDateTime은 workDate + KST HH:MM을 UTC로 환산한다', () => {
    const d = combineDateTime(new Date(Date.UTC(2026, 8, 30)), '09:00');
    expect(d.toISOString()).toBe('2026-09-30T00:00:00.000Z'); // KST 09:00
  });

  it('resolveEndTime은 자정을 넘긴 종료시각을 다음날로 보정한다', () => {
    const s = new Date(Date.UTC(2026, 8, 30, 13, 0)); // 22:00 KST
    const e = new Date(Date.UTC(2026, 8, 30, 17, 0)); // 02:00 KST(같은 날 UTC)
    expect(resolveEndTime(s, e).getTime() - s.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it('lunchOverlapMinutes는 실제 겹치는 만큼만 뺀다', () => {
    const w = { startHHMM: '12:00', endHHMM: '13:00' };
    const mk = (h1: number, h2: number) => ({
      s: new Date(Date.UTC(2026, 8, 30, h1 - 9, 0)),
      e: new Date(Date.UTC(2026, 8, 30, h2 - 9, 0)),
    });
    let r = mk(9, 11); expect(lunchOverlapMinutes(r.s, r.e, w)).toBe(0);    // 점심 전
    r = mk(11, 14); expect(lunchOverlapMinutes(r.s, r.e, w)).toBe(60);      // 완전 포함
    r = mk(12, 18); expect(lunchOverlapMinutes(r.s, r.e, w)).toBe(60);
    r = mk(12, 12); expect(lunchOverlapMinutes(r.s, r.e, w)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 위치대조
// ─────────────────────────────────────────────────────────────────────────────
describe('checkLocationMatch', () => {
  const client = { latitude: 37.5, longitude: 127.0 };
  it('반경 이내면 일치', () => {
    const r = checkLocationMatch({ lat: 37.5005, lng: 127.0 }, client);
    expect(r?.locationMatch).toBe(true);
  });
  it('멀면 불일치', () => {
    const r = checkLocationMatch({ lat: 37.6, lng: 127.0 }, client);
    expect(r?.locationMatch).toBe(false);
  });
  it('GPS 오차범위는 상한(1000m)까지만 반영된다', () => {
    const far = { lat: 37.52, lng: 127.0 }; // 약 2.2km
    expect(checkLocationMatch(far, client, 1000, 0)?.locationMatch).toBe(false);
    expect(checkLocationMatch(far, client, 1000, 999999)?.effectiveRadiusMeters).toBe(2000);
  });
  it('좌표 미등록이면 null(대조 시도 안 함)', () => {
    expect(checkLocationMatch({ lat: 37.5, lng: 127.0 }, { latitude: null, longitude: null })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C-2: async 라우터 래퍼
// ─────────────────────────────────────────────────────────────────────────────
describe('C-2 createRouter (async 예외 래핑)', () => {
  it('async 핸들러의 rejection을 next(err)로 넘긴다 — 프로세스 종료 방지의 핵심', async () => {
    const router = createRouter();
    let received: unknown = null;
    router.get('/boom', async () => {
      throw new Error('async 실패');
    });
    // 라우터를 직접 호출해 미들웨어 체인을 태운다
    await new Promise<void>((resolve) => {
      const handlers = (router as unknown as { stack: { route?: { stack: { handle: unknown }[] } }[] }).stack
        .find((l) => l.route)!.route!.stack.map((h) => h.handle);
      const handler = handlers[handlers.length - 1] as (req: unknown, res: unknown, next: (e?: unknown) => void) => void;
      handler({} as never, {} as never, (e?: unknown) => { received = e; resolve(); });
      setTimeout(resolve, 500);
    });
    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe('async 실패');
  });

  it('핸들러가 __asyncWrapped 표식을 갖는다(누락 방지)', () => {
    const router = createRouter();
    const fn = async () => undefined;
    router.get('/ok', fn);
    const stack = (router as unknown as { stack: { route?: { stack: { handle: unknown }[] } }[] }).stack;
    const handle = stack.find((l) => l.route)!.route!.stack[0].handle;
    expect(isAsyncWrapped(handle)).toBe(true);
  });

  it('동기 예외도 next(err)로 넘긴다', async () => {
    const router = createRouter();
    router.get('/sync', () => { throw new Error('sync 실패'); });
    let received: unknown = null;
    await new Promise<void>((resolve) => {
      const stack = (router as unknown as { stack: { route?: { stack: { handle: unknown }[] } }[] }).stack;
      const handle = stack.find((l) => l.route)!.route!.stack[0].handle as (r: unknown, s: unknown, n: (e?: unknown) => void) => void;
      handle({} as never, {} as never, (e?: unknown) => { received = e; resolve(); });
      setTimeout(resolve, 300);
    });
    expect((received as Error).message).toBe('sync 실패');
  });
});

describe('H-6 JWT_SECRET fail-fast', () => {
  it('설정이 없으면 모듈 로드 시 예외를 던진다', () => {
    const { execFileSync } = require('child_process');
    // 자식 프로세스에서 JWT_SECRET 없이 모듈을 로드해 fail-fast 여부를 확인한다.
    // (ts-node/register를 써서 TS를 직접 require — `ts-node -e`는 eval 문자열을 타입체크해서 쓸 수 없다)
    const script = [
      "require('ts-node/register');",
      'delete process.env.JWT_SECRET;',
      "try { require('./src/common/guards/auth.ts'); console.log('NO_THROW'); }",
      "catch (e) { console.log('THREW:' + String(e && e.message).slice(0, 60)); }",
    ].join('\n');
    let out = '';
    try {
      out = execFileSync('node', ['-e', script], { encoding: 'utf-8', timeout: 120000 });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      out = String(e?.stdout || '') + String(e?.stderr || '');
    }
    expect(out).toContain('THREW:');
  });
});
