import express, { type RequestHandler, type Router as ExpressRouter } from 'express';

/**
 * 2026-09-30 수정(Critical): async 라우트 핸들러에서 던져진 예외가 백엔드 프로세스를 종료시키던 문제.
 *
 * 배경: 이 프로젝트의 모든 라우트 핸들러가 async인데 try/catch가 없고, app.ts의 공통 에러 핸들러는
 * 동기 예외만 잡는다. Express 4는 핸들러가 반환한 Promise의 rejection을 처리하지 않으므로, 핸들러
 * 안에서 예외가 나면 그대로 unhandled rejection이 되고, Node 20의 기본값
 * (--unhandled-rejections=throw)에서 프로세스 자체가 종료된다 — 인증된 직원 1명이 잘못된 입력
 * 한 번으로 백엔드 전체를 재시작시킬 수 있는 원격 DoS 경로였다.
 *
 * 실측 재현 경로(수정 전):
 *  - POST /attendance/status  {"effort":{"clientId":"abc"}}  → prisma P2023
 *  - POST /attendance/clock-in {"locationAddress":{"a":1}}   → TypeError: replace is not a function
 *  - POST /reports/unresolved-clockouts/abc/force-clock-out  → prisma P2023
 *  - GET  /dashboard/day?date=9999-99-99                     → Invalid Date → prisma 예외
 *
 * 해결: 라우터에 등록되는 핸들러를 한 겹 감싸서, 반환된 Promise가 reject되면 next(err)로 넘겨
 * 기존 공통 에러 핸들러(500)가 처리하게 한다. 라우트 파일 22개를 전부 고치는 대신 라우터를
 * 만드는 지점(createRouter)에서 한 번만 감싸므로, 나중에 새 라우트를 추가할 때도 누락될 위험이 없다.
 *
 * 주의: express.Router()를 그대로 쓰면 래핑되지 않는다 — 각 라우트 모듈은 Router 대신
 * createRouter를 쓴다. app.use()에 등록되는 미들웨어/하위 라우터는 대상이 아니며, use()로
 * 등록되는 async 미들웨어(requireAuth)는 자체적으로 try/catch를 갖도록 따로 고쳤다.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

type AnyFn = (...args: unknown[]) => unknown;

function wrap(handler: unknown): unknown {
  if (typeof handler !== 'function') return handler;
  const fn = handler as AnyFn & { __asyncWrapped?: boolean };
  if (fn.__asyncWrapped) return handler;
  // (err, req, res, next) 형태의 에러 핸들러(4-arity)는 그대로 둔다.
  if (fn.length >= 4) return handler;

  const wrapped = function asyncWrappedHandler(req: unknown, res: unknown, next: unknown) {
    const nextFn = next as (err?: unknown) => void;
    try {
      const result = fn(req, res, nextFn);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch(nextFn);
      }
      return result;
    } catch (err) {
      nextFn(err);
      return undefined;
    }
  };
  Object.defineProperty(wrapped, '__asyncWrapped', { value: true });
  return wrapped;
}

function wrapArgs(args: unknown[]): unknown[] {
  return args.map((a) => (Array.isArray(a) ? wrapArgs(a) : wrap(a)));
}

/**
 * express.Router()와 동일하지만, 등록되는 라우트 핸들러를 async 안전하게 감싼 라우터를 만든다.
 * 라우터 함수 자체(마운트용)는 원본 그대로라 app.use('/api/v1/x', router) 방식의 마운트도 동일하게 동작한다.
 */
export function createRouter(): ExpressRouter {
  const router = express.Router();
  for (const method of METHODS) {
    const original = (router as unknown as Record<string, AnyFn | undefined>)[method];
    if (typeof original !== 'function') continue;
    const bound = original.bind(router) as AnyFn;
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => bound(...wrapArgs(args));
  }
  return router;
}

/** 래핑 여부를 외부에서 확인할 수 있게 노출(테스트/디버그용). */
export function isAsyncWrapped(handler: unknown): boolean {
  return Boolean((handler as { __asyncWrapped?: boolean } | null)?.__asyncWrapped);
}

export type { RequestHandler };
