/**
 * 2026-10-11: "엔지니어의 출근·퇴근·작업시간·작업내용·고객사 담당자는 필수" 원칙(대표 지시)을
 * 서버에서 판정하는 순수 함수들. DB·Express에 의존하지 않아 단위 테스트가 쉽다.
 * 각 규칙은 관리자 정책값으로 켜고 끌 수 있다(attendance.routes.ts에서 정책값을 읽어 넘긴다) —
 * 현장에서 예상치 못한 문제가 생기면 코드 재배포 없이 정책값만 바꿔 즉시 완화할 수 있다.
 */

/** 담당자 + 작업내용을 필수로 받는 상태 */
export const CONTACT_REQUIRED_STATUSES = new Set(['CLIENT_WORK', 'CLIENT_MEETING']);

export interface DetailEffortInput {
  description?: string | null;
  endTime?: string | null;
  inProgress?: boolean | null;
  contactId?: string | null;
  contactName?: string | null;
}

/**
 * 고객사작업/미팅의 "세부 저장"(작업내용이나 완료시간이 들어 있는 저장)에서 빠진 필수 항목을 찾는다.
 * 도착 직후의 즉시등록(시작시간+고객사만 보내는 저장)은 여기서 걸리지 않는다 —
 * "도착 → 위치확인 → 먼저 저장 → 나중에 마무리" 흐름을 막지 않기 위해서다.
 * 반환값이 null이 아니면 그 코드로 400을 돌려준다.
 */
export function missingDetailField(
  status: string,
  effort: DetailEffortInput | undefined,
  opts: { enforceDescription: boolean; enforceContact: boolean }
): 'DESCRIPTION_REQUIRED' | 'CONTACT_REQUIRED' | null {
  if (!CONTACT_REQUIRED_STATUSES.has(status) || !effort) return null;
  const hasDescription = Boolean(effort.description && effort.description.trim());
  const isDetailSave = hasDescription || Boolean(effort.endTime && effort.endTime.trim());
  if (!isDetailSave) return null;
  if (opts.enforceDescription && !hasDescription) return 'DESCRIPTION_REQUIRED';
  if (opts.enforceContact) {
    const hasContact = Boolean(effort.contactId) || Boolean(effort.contactName && effort.contactName.trim());
    if (!hasContact) return 'CONTACT_REQUIRED';
  }
  return null;
}

/**
 * 2026-10-12: "위치가 TSB의 핵심 — 본사출근·고객사작업·고객사미팅은 위치가 반드시 일치해야 등록"(대표 지시)에 따른
 * 엄격 모드(정책값 ENFORCE_LOCATION_MATCH=1)가 적용되는 상태. 야간/주말작업 등 그 외 상태는 기존 규칙을 유지한다.
 */
export const STRICT_LOCATION_STATUSES = new Set(['HQ_WORKING', 'CLIENT_WORK', 'CLIENT_MEETING']);

export function isStrictLocationStatus(status: string, strictEnabled: boolean): boolean {
  return strictEnabled && STRICT_LOCATION_STATUSES.has(status);
}

export type LowAccuracyDecision = 'NOT_LOW' | 'NEED_RECHECK' | 'PASS_AFTER_RECHECK';

/**
 * 위치가 등록 위치와 맞지 않는데 GPS 자체의 오차범위가 너무 큰 경우의 판정.
 * - 예전: 오차범위가 maxAccuracy(1km)보다 크면 무조건 통과(불일치로만 기록).
 * - 지금: 처음엔 "건물 밖에서 다시 측정"을 요구하고(NEED_RECHECK), 재측정을 한 번이라도 했는데도
 *   여전히 부정확하면 그때는 출근/등록이 막히지 않게 통과시키되 관리자 확인 대상으로 표시한다
 *   (PASS_AFTER_RECHECK) — "위치가 안 잡혀서 출근을 못 하는 사람"이 생기면 안 되기 때문이다.
 * enabled=false 이면 예전 동작(바로 통과)으로 되돌린다.
 * strict=true(엄격 모드)이면 몇 번을 재측정해도 통과시키지 않는다 — 오차범위가 허용치 이하로 줄어
 * 위치가 실제로 일치해야만 등록된다(항상 NEED_RECHECK).
 */
export function lowAccuracyDecision(p: {
  accuracyMeters: number | null | undefined;
  maxAccuracyMeters: number;
  recheckCount: number;
  enabled: boolean;
  strict?: boolean;
}): LowAccuracyDecision {
  const low = typeof p.accuracyMeters === 'number' && Number.isFinite(p.accuracyMeters) && p.accuracyMeters > p.maxAccuracyMeters;
  if (!low) return 'NOT_LOW';
  if (p.strict) return 'NEED_RECHECK';
  if (!p.enabled) return 'PASS_AFTER_RECHECK';
  return p.recheckCount >= 1 ? 'PASS_AFTER_RECHECK' : 'NEED_RECHECK';
}

export const MIN_LOCATION_FAILURE_REASON_LENGTH = 5;

export type LocationFailureDecision = 'ALLOW_GRACE' | 'ALLOW_WITH_REASON' | 'BLOCK';

/**
 * 위치를 아예 못 구한 경우(권한거부/타임아웃 등)의 판정.
 * - 오늘 이미 봐준 횟수(priorFailures)가 graceCount 미만이면 예전처럼 봐준다.
 *   (기본 graceCount는 0 — "무조건 위치 확인" 원칙. 정책값으로 1로 되돌리면 예전 동작)
 * - 그 이후에도 사유(5자 이상)를 직접 입력하면 등록은 허용하되 관리자 확인 대상으로 남긴다.
 * - 둘 다 아니면 막는다.
 */
export function locationFailureDecision(p: {
  priorFailures: number;
  graceCount: number;
  reason: string | null | undefined;
  strict?: boolean;
}): LocationFailureDecision {
  // 엄격 모드: 위치를 못 구하면 봐주기도, 사유 입력으로 대체하는 것도 없다 — 위치를 확인해야만 등록된다.
  if (p.strict) return 'BLOCK';
  if (p.priorFailures < p.graceCount) return 'ALLOW_GRACE';
  if ((p.reason ?? '').trim().length >= MIN_LOCATION_FAILURE_REASON_LENGTH) return 'ALLOW_WITH_REASON';
  return 'BLOCK';
}

export type AutoCloseReason = 'AWAY' | 'STATUS_CHANGE' | 'CLOCK_OUT';

export const AUTO_CLOSE_AWAY_MINUTES = 30;

export function closedByFor(reason: AutoCloseReason): 'AUTO_AWAY' | 'AUTO_STATUS_CHANGE' | 'AUTO_CLOCKOUT' {
  return reason === 'AWAY' ? 'AUTO_AWAY' : reason === 'STATUS_CHANGE' ? 'AUTO_STATUS_CHANGE' : 'AUTO_CLOCKOUT';
}

/**
 * 열려 있는 고객사 작업을 자동으로 마무리할 때의 종료시각.
 * - AWAY(고객사 위치에서 30분 이상 벗어남을 앱이 감지): 벗어난 것을 처음 확인한 시각(awaySince).
 *   없으면 "지금 − 30분"(= 감지 시각의 30분 전).
 * - STATUS_CHANGE(직원이 다른 상태로 바꿈): 지금.
 * - CLOCK_OUT(퇴근): 퇴근 위치가 그 고객사가 아니고 마지막으로 고객사에 있었음을 확인한 시각(lastSeenAt)이
 *   있으며 그 뒤 30분 이상 지났으면 그 시각, 아니면 퇴근 시각.
 * 결과는 항상 [시작시각, 지금] 범위 안으로 맞춘다(시작보다 앞서거나 미래가 되지 않게).
 */
export function resolveAutoCloseEnd(p: {
  reason: AutoCloseReason;
  startTime: Date;
  now: Date;
  awaySince?: Date | null;
  lastSeenAt?: Date | null;
  awayFromClientAtClockOut?: boolean;
}): Date {
  let end: Date;
  if (p.reason === 'AWAY') {
    end = p.awaySince ?? new Date(p.now.getTime() - AUTO_CLOSE_AWAY_MINUTES * 60_000);
  } else if (p.reason === 'CLOCK_OUT') {
    const sinceSeenMin = p.lastSeenAt ? (p.now.getTime() - p.lastSeenAt.getTime()) / 60_000 : 0;
    end = p.awayFromClientAtClockOut && p.lastSeenAt && sinceSeenMin >= AUTO_CLOSE_AWAY_MINUTES ? p.lastSeenAt : p.now;
  } else {
    end = p.now;
  }
  if (end.getTime() > p.now.getTime()) end = p.now;
  if (end.getTime() < p.startTime.getTime()) end = p.startTime;
  return end;
}

/** 담당자 이름/전화번호 입력을 정리한다(공백 제거·길이 제한). 이름이 비면 null. */
export function normalizeContactInput(raw: { name?: string | null; phone?: string | null }): { name: string; phone: string | null } | null {
  const name = (raw.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
  if (!name) return null;
  const phone = (raw.phone ?? '').trim().slice(0, 30);
  return { name, phone: phone || null };
}

export const MAX_AUTO_ESTIMATE_HOURS = 10;

export type EstimateVerdict = 'OK' | 'NO_NEXT' | 'TOO_LONG' | 'INVALID';

/**
 * 과거에 종료시각 없이 남은 고객사 작업의 종료시각을 "그 뒤 처음 일어난 일"로 추정한다.
 * candidates = 이 직원의 다음 상태 변경 시각, 다음 다른 작업의 시작시각 등. 시작보다 뒤인 가장 이른 시각을 쓴다.
 * 10시간을 넘으면 사람이 직접 확인해야 하므로 TOO_LONG(자동 적용 대상 아님), 근거가 없으면 NO_NEXT.
 */
export function estimateOpenEffortEnd(p: {
  startTime: Date;
  candidates: Array<Date | null | undefined>;
  maxHours?: number;
}): { end: Date | null; minutes: number | null; verdict: EstimateVerdict } {
  const maxMinutes = (p.maxHours ?? MAX_AUTO_ESTIMATE_HOURS) * 60;
  const valid = p.candidates.filter((c): c is Date => c instanceof Date && !Number.isNaN(c.getTime()) && c.getTime() > p.startTime.getTime());
  if (valid.length === 0) return { end: null, minutes: null, verdict: 'NO_NEXT' };
  const end = valid.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  const minutes = Math.round((end.getTime() - p.startTime.getTime()) / 60_000);
  if (minutes <= 0) return { end, minutes, verdict: 'INVALID' };
  if (minutes > maxMinutes) return { end, minutes, verdict: 'TOO_LONG' };
  return { end, minutes, verdict: 'OK' };
}

/**
 * 2026-10-12: "엔지니어 공수관리를 위해 작업시간·내용·고객사 담당자는 무조건 기록"(대표 지시) — 퇴근 시점에 오늘 등록한
 * 고객사작업/미팅 기록 중 작업내용이나 담당자가 비어 있는 것이 있는지 찾는다(정책값 ENFORCE_EFFORT_COMPLETE_AT_CLOCKOUT=1일 때만 사용).
 * 도착 즉시등록(내용·담당자 없음)은 허용하되, 하루를 마칠 때까지는 반드시 채워야 한다는 뜻이다.
 */
export function findIncompleteEffort(
  efforts: { clientName: string; description?: string | null; contactId?: string | null; contactName?: string | null }[],
  opts: { enforceDescription: boolean; enforceContact: boolean }
): { clientName: string; missing: 'DESCRIPTION' | 'CONTACT' } | null {
  for (const e of efforts) {
    if (opts.enforceDescription && !(e.description && e.description.trim())) return { clientName: e.clientName, missing: 'DESCRIPTION' };
    if (opts.enforceContact && !(e.contactId || (e.contactName && e.contactName.trim()))) return { clientName: e.clientName, missing: 'CONTACT' };
  }
  return null;
}
