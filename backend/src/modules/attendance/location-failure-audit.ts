import type { NextFunction, Request, Response } from 'express';
import { recordAuditLog } from '../../common/audit';

/**
 * 2026-10-15: 위치 확인에 실패해 "출근"/상태 등록이 거절된 시도를 좌표 없이 감사로그에 남긴다.
 * (실제 신고: PC로 출근이 여러 번 안 되다가 겨우 됨 — 거절된 요청은 어디에도 저장되지 않아 원인을 알 수 없었다.)
 *  - 남기는 것: 어떤 요청(출근/상태 등록)인지, 오류 종류, 시도한 상태, GPS 오차, 위치 전송 여부, 위치 측정 상태, 기기 종류(PC/휴대폰).
 *  - 남기지 않는 것: 좌표, IP, User-Agent 원문.
 * actionType은 기존 값(STATUS_CHANGE)을 쓰고 targetType 으로 구분한다(DB 변경 없음). 기록 실패는 사용자 응답을 막지 않는다.
 */
export const LOCATION_FAILURE_AUDIT_TARGET = 'location_failure';

export type FailureEndpoint = 'CLOCK_IN' | 'STATUS';
export type FailureDevice = 'PC' | 'MOBILE' | 'UNKNOWN';

/** 위치 문제로 거절된 응답의 오류 코드와 화면에 보여줄 한글 이름. */
export const LOCATION_FAILURE_LABELS: Record<string, string> = {
  GPS_ACCURACY_LOW: 'GPS 오차가 큼',
  LOCATION_REQUIRED: '위치를 확인하지 못함',
  LOCATION_REQUIRED_STRICT: '위치를 확인하지 못함(엄격 모드)',
  LOCATION_REQUIRED_FOR_WORK_START: '위치를 확인하지 못함(근무 시작)',
  LOCATION_REQUIRED_FOR_CLOCKIN: '출근 버튼: 위치를 확인하지 못함',
  AWAY_FROM_HQ: '본사에서 떨어져 있음',
  LOCATION_MISMATCH_TOO_FAR: '등록 위치와 너무 멀어 지도 보정 불가',
  LOCATION_MISMATCH_BLOCKED: '등록 위치와 맞지 않아 막힘',
  LOCATION_CORRECTION_NOT_AT_TARGET: '지도로 보정한 위치가 대상과 다름',
};

/** 상태 등록에서는 이 두 코드를 이미 location_block(고객사·거리 포함)으로 남기므로 중복 기록하지 않는다. */
const STATUS_ALREADY_LOGGED = new Set(['LOCATION_MISMATCH_BLOCKED', 'LOCATION_CORRECTION_NOT_AT_TARGET']);

export function shouldRecordLocationFailure(endpoint: FailureEndpoint, code: unknown): code is string {
  if (typeof code !== 'string' || !(code in LOCATION_FAILURE_LABELS)) return false;
  if (endpoint === 'STATUS' && STATUS_ALREADY_LOGGED.has(code)) return false;
  return true;
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Mobi|Windows Phone|webOS|BlackBerry/i;
/** User-Agent 에서 기기 종류만 뽑는다(원문은 저장하지 않는다). */
export function classifyDevice(userAgent: string | undefined | null): FailureDevice {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'UNKNOWN';
  return MOBILE_UA.test(ua) ? 'MOBILE' : 'PC';
}

export interface LocationFailureRecord {
  endpoint: FailureEndpoint;
  code: string;
  status: string | null;
  accuracyMeters: number | null;
  hasLocation: boolean;
  locationStatus: string | null;
  device: FailureDevice;
}

const shortStr = (v: unknown, max = 40): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const finiteNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

export function buildLocationFailureRecord(p: { endpoint: FailureEndpoint; code: string; reqBody: any; errorBody: any; userAgent?: string | null }): LocationFailureRecord {
  const b = p.reqBody && typeof p.reqBody === 'object' ? p.reqBody : {};
  return {
    endpoint: p.endpoint,
    code: p.code,
    status: p.endpoint === 'STATUS' ? shortStr(b.status) : null,
    // 서버 응답의 오차값(GPS_ACCURACY_LOW)을 우선하고, 없으면 요청에 담겨 온 값을 쓴다.
    accuracyMeters: finiteNum(p.errorBody?.error?.accuracyMeters) ?? finiteNum(b.accuracyMeters),
    hasLocation: Boolean(b.location && typeof b.location === 'object'),
    locationStatus: shortStr(b.locationStatus),
    device: classifyDevice(p.userAgent),
  };
}

/** /clock-in, /status 의 오류 응답을 가로채 위치 실패를 기록하는 미들웨어(requireAuth 뒤에 둔다). 응답 내용은 바꾸지 않는다. */
export function locationFailureRecorder(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'POST' || (req.path !== '/clock-in' && req.path !== '/status')) return next();
  const endpoint: FailureEndpoint = req.path === '/clock-in' ? 'CLOCK_IN' : 'STATUS';
  const originalJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    try {
      const code = body?.error?.code;
      const userId = (req as any).authUser?.userId as string | undefined;
      if (userId && res.statusCode >= 400 && shouldRecordLocationFailure(endpoint, code)) {
        const record = buildLocationFailureRecord({ endpoint, code, reqBody: req.body, errorBody: body, userAgent: req.headers['user-agent'] });
        void recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: LOCATION_FAILURE_AUDIT_TARGET, afterValue: record as any })
          .catch((e) => console.error('[location-failure] audit log failed', e));
      }
    } catch (e) {
      console.error('[location-failure] record failed', e);
    }
    return originalJson(body);
  };
  next();
}

export interface FailureEvent extends LocationFailureRecord { at: Date; userId: string; userName: string }

export interface FailureSummary {
  total: number;
  userCount: number;
  byDevice: { device: FailureDevice; count: number; userCount: number }[];
  byCode: { code: string; label: string; count: number; userCount: number }[];
  users: { userName: string; count: number; lastAt: string; devices: FailureDevice[]; codes: string[]; medianAccuracyMeters: number | null }[];
  recent: { at: string; userName: string; endpoint: FailureEndpoint; status: string | null; label: string; accuracyMeters: number | null; hasLocation: boolean; locationStatus: string | null; device: FailureDevice }[];
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** 관리자 화면용 요약 — 기기별·오류별·직원별 건수와 최근 시도. 좌표는 없다. */
export function summarizeLocationFailures(events: FailureEvent[], opts: { userLimit?: number; recentLimit?: number } = {}): FailureSummary {
  const userLimit = opts.userLimit ?? 30;
  const recentLimit = opts.recentLimit ?? 40;
  const users = new Set(events.map((e) => e.userId));
  const group = <K extends string>(keyOf: (e: FailureEvent) => K) => {
    const m = new Map<K, { count: number; users: Set<string> }>();
    for (const e of events) {
      const k = keyOf(e);
      const g = m.get(k) ?? { count: 0, users: new Set<string>() };
      g.count += 1; g.users.add(e.userId); m.set(k, g);
    }
    return m;
  };
  const byDevice = [...group((e) => e.device).entries()].map(([device, g]) => ({ device, count: g.count, userCount: g.users.size })).sort((a, b) => b.count - a.count);
  const byCode = [...group((e) => e.code).entries()].map(([code, g]) => ({ code, label: LOCATION_FAILURE_LABELS[code] ?? code, count: g.count, userCount: g.users.size })).sort((a, b) => b.count - a.count);
  const perUser = new Map<string, FailureEvent[]>();
  for (const e of events) perUser.set(e.userId, [...(perUser.get(e.userId) ?? []), e]);
  const userRows = [...perUser.values()].map((list) => {
    const last = list.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
    return {
      userName: last.userName,
      count: list.length,
      lastAt: last.at.toISOString(),
      devices: [...new Set(list.map((e) => e.device))],
      codes: [...new Set(list.map((e) => LOCATION_FAILURE_LABELS[e.code] ?? e.code))],
      medianAccuracyMeters: median(list.map((e) => e.accuracyMeters).filter((n): n is number => n != null)),
    };
  }).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, userLimit);
  const recent = [...events].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, recentLimit).map((e) => ({
    at: e.at.toISOString(), userName: e.userName, endpoint: e.endpoint, status: e.status,
    label: LOCATION_FAILURE_LABELS[e.code] ?? e.code, accuracyMeters: e.accuracyMeters, hasLocation: e.hasLocation, locationStatus: e.locationStatus, device: e.device,
  }));
  return { total: events.length, userCount: users.size, byDevice, byCode, users: userRows, recent };
}
