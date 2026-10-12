import {
  missingDetailField,
  lowAccuracyDecision,
  locationFailureDecision,
  resolveAutoCloseEnd,
  closedByFor,
  normalizeContactInput,
  estimateOpenEffortEnd,
  isStrictLocationStatus, findIncompleteEffort,
} from '../modules/attendance/field-rules';

const ON = { enforceDescription: true, enforceContact: true };

describe('missingDetailField — 고객사 작업·미팅 필수 입력', () => {
  it('도착 직후 즉시등록(시작시간+고객사만)은 막지 않는다', () => {
    expect(missingDetailField('CLIENT_WORK', {}, ON)).toBeNull();
    expect(missingDetailField('CLIENT_MEETING', { description: '   ' }, ON)).toBeNull();
  });
  it('작업내용이 있는데 담당자가 없으면 CONTACT_REQUIRED', () => {
    expect(missingDetailField('CLIENT_WORK', { description: '점검' }, ON)).toBe('CONTACT_REQUIRED');
    expect(missingDetailField('CLIENT_MEETING', { description: '미팅', contactName: '  ' }, ON)).toBe('CONTACT_REQUIRED');
  });
  it('완료시간만 있고 내용이 없으면 DESCRIPTION_REQUIRED(내용이 담당자보다 먼저)', () => {
    expect(missingDetailField('CLIENT_WORK', { endTime: '17:00' }, ON)).toBe('DESCRIPTION_REQUIRED');
  });
  it('담당자를 id 또는 이름으로 주면 통과', () => {
    expect(missingDetailField('CLIENT_WORK', { description: '점검', contactId: 'x' }, ON)).toBeNull();
    expect(missingDetailField('CLIENT_WORK', { description: '점검', contactName: '김대리' }, ON)).toBeNull();
  });
  it('다른 상태(본사근무/재택/야간)는 영향 없음', () => {
    for (const st of ['HQ_WORKING', 'REMOTE', 'NIGHT_WORK', 'WEEKEND_WORK', 'MOVING']) {
      expect(missingDetailField(st, { description: '내용', endTime: '10:00' }, ON)).toBeNull();
    }
  });
  it('정책으로 끄면(0) 해당 항목은 검사하지 않는다', () => {
    expect(missingDetailField('CLIENT_WORK', { description: '점검' }, { enforceDescription: true, enforceContact: false })).toBeNull();
    expect(missingDetailField('CLIENT_WORK', { endTime: '17:00' }, { enforceDescription: false, enforceContact: true })).toBe('CONTACT_REQUIRED');
  });
});

describe('lowAccuracyDecision — GPS 오차 1km 초과', () => {
  const base = { maxAccuracyMeters: 1000, enabled: true };
  it('오차가 1km 이하면 해당 없음', () => {
    expect(lowAccuracyDecision({ ...base, accuracyMeters: 1000, recheckCount: 0 })).toBe('NOT_LOW');
    expect(lowAccuracyDecision({ ...base, accuracyMeters: null, recheckCount: 0 })).toBe('NOT_LOW');
    expect(lowAccuracyDecision({ ...base, accuracyMeters: NaN, recheckCount: 0 })).toBe('NOT_LOW');
  });
  it('1km 초과 첫 시도는 재측정 요구, 재측정 1회 이후엔 통과(출근은 지켜짐)', () => {
    expect(lowAccuracyDecision({ ...base, accuracyMeters: 2800, recheckCount: 0 })).toBe('NEED_RECHECK');
    expect(lowAccuracyDecision({ ...base, accuracyMeters: 2800, recheckCount: 1 })).toBe('PASS_AFTER_RECHECK');
  });
  it('정책을 끄면 예전처럼 바로 통과', () => {
    expect(lowAccuracyDecision({ ...base, enabled: false, accuracyMeters: 2800, recheckCount: 0 })).toBe('PASS_AFTER_RECHECK');
  });
});

describe('locationFailureDecision — 위치를 못 구한 경우', () => {
  it('기본(봐주기 0회): 사유 없으면 차단, 5자 이상 사유면 허용', () => {
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 0, reason: undefined })).toBe('BLOCK');
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 0, reason: '1234' })).toBe('BLOCK');
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 0, reason: '  지하 기계실  ' })).toBe('ALLOW_WITH_REASON');
  });
  it('정책으로 1회 봐주기를 켜면 첫 실패는 허용, 두 번째부터 차단', () => {
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 1, reason: '' })).toBe('ALLOW_GRACE');
    expect(locationFailureDecision({ priorFailures: 1, graceCount: 1, reason: '' })).toBe('BLOCK');
  });
});

describe('resolveAutoCloseEnd — 자동 마무리 종료시각', () => {
  const start = new Date('2026-10-12T01:00:00Z'); // 10:00 KST
  const now = new Date('2026-10-12T07:00:00Z'); // 16:00 KST
  it('고객사에서 30분 이상 벗어남: 벗어남을 처음 확인한 시각(없으면 지금−30분)', () => {
    const since = new Date('2026-10-12T06:20:00Z');
    expect(resolveAutoCloseEnd({ reason: 'AWAY', startTime: start, now, awaySince: since })).toEqual(since);
    expect(resolveAutoCloseEnd({ reason: 'AWAY', startTime: start, now })).toEqual(new Date('2026-10-12T06:30:00Z'));
  });
  it('상태 변경: 지금', () => {
    expect(resolveAutoCloseEnd({ reason: 'STATUS_CHANGE', startTime: start, now })).toEqual(now);
  });
  it('퇴근: 퇴근 위치가 고객사가 아니고 마지막 확인 후 30분 이상 → 마지막 확인 시각, 아니면 퇴근 시각', () => {
    const seen = new Date('2026-10-12T05:00:00Z');
    expect(resolveAutoCloseEnd({ reason: 'CLOCK_OUT', startTime: start, now, lastSeenAt: seen, awayFromClientAtClockOut: true })).toEqual(seen);
    expect(resolveAutoCloseEnd({ reason: 'CLOCK_OUT', startTime: start, now, lastSeenAt: seen, awayFromClientAtClockOut: false })).toEqual(now);
    expect(resolveAutoCloseEnd({ reason: 'CLOCK_OUT', startTime: start, now, awayFromClientAtClockOut: true })).toEqual(now);
    const recent = new Date('2026-10-12T06:50:00Z');
    expect(resolveAutoCloseEnd({ reason: 'CLOCK_OUT', startTime: start, now, lastSeenAt: recent, awayFromClientAtClockOut: true })).toEqual(now);
  });
  it('시작보다 앞서거나 미래가 되지 않게 맞춘다', () => {
    expect(resolveAutoCloseEnd({ reason: 'AWAY', startTime: start, now, awaySince: new Date('2026-10-12T00:00:00Z') })).toEqual(start);
    expect(resolveAutoCloseEnd({ reason: 'AWAY', startTime: start, now, awaySince: new Date('2026-10-12T09:00:00Z') })).toEqual(now);
  });
  it('closedBy 표식', () => {
    expect(closedByFor('AWAY')).toBe('AUTO_AWAY');
    expect(closedByFor('STATUS_CHANGE')).toBe('AUTO_STATUS_CHANGE');
    expect(closedByFor('CLOCK_OUT')).toBe('AUTO_CLOCKOUT');
  });
});

describe('normalizeContactInput', () => {
  it('공백 정리·길이 제한·빈 이름은 null', () => {
    expect(normalizeContactInput({ name: '  김  대리 ', phone: ' 010-1234-5678 ' })).toEqual({ name: '김 대리', phone: '010-1234-5678' });
    expect(normalizeContactInput({ name: '   ' })).toBeNull();
    expect(normalizeContactInput({ name: 'a'.repeat(80) })!.name).toHaveLength(50);
    expect(normalizeContactInput({ name: '박과장', phone: '  ' })).toEqual({ name: '박과장', phone: null });
  });
});

describe('estimateOpenEffortEnd — 과거 미종료 작업 추정', () => {
  const start = new Date('2026-10-05T01:00:00Z');
  it('시작 뒤 가장 이른 후보를 쓰고, 10시간 이내면 OK', () => {
    const r = estimateOpenEffortEnd({ startTime: start, candidates: [new Date('2026-10-05T08:00:00Z'), new Date('2026-10-05T05:00:00Z'), null, undefined] });
    expect(r.verdict).toBe('OK');
    expect(r.end).toEqual(new Date('2026-10-05T05:00:00Z'));
    expect(r.minutes).toBe(240);
  });
  it('시작 이전/같은 시각 후보는 무시, 근거가 없으면 NO_NEXT', () => {
    expect(estimateOpenEffortEnd({ startTime: start, candidates: [start, new Date('2026-10-05T00:00:00Z')] }).verdict).toBe('NO_NEXT');
    expect(estimateOpenEffortEnd({ startTime: start, candidates: [] }).verdict).toBe('NO_NEXT');
  });
  it('10시간 초과는 TOO_LONG(자동 적용 대상 아님), 경계값 10시간은 OK', () => {
    expect(estimateOpenEffortEnd({ startTime: start, candidates: [new Date('2026-10-05T11:01:00Z')] }).verdict).toBe('TOO_LONG');
    expect(estimateOpenEffortEnd({ startTime: start, candidates: [new Date('2026-10-05T11:00:00Z')] }).verdict).toBe('OK');
  });
});

describe('위치 일치 강제(엄격 모드) 규칙', () => {
  it('엄격 모드는 본사근무·고객사작업·고객사미팅에만 적용되고, 꺼져 있으면 아무 상태에도 적용되지 않는다', () => {
    for (const st of ['HQ_WORKING', 'CLIENT_WORK', 'CLIENT_MEETING']) {
      expect(isStrictLocationStatus(st, true)).toBe(true);
      expect(isStrictLocationStatus(st, false)).toBe(false);
    }
    for (const st of ['NIGHT_WORK', 'WEEKEND_WORK', 'REMOTE', 'MOVING', 'BUSINESS_TRIP', 'RESIDENT_ONSITE']) {
      expect(isStrictLocationStatus(st, true)).toBe(false);
    }
  });
  it('lowAccuracyDecision: 엄격 모드면 재측정을 몇 번 해도 통과시키지 않는다(정책 off여도 마찬가지)', () => {
    const base = { accuracyMeters: 2800, maxAccuracyMeters: 1000, enabled: true, strict: true };
    expect(lowAccuracyDecision({ ...base, recheckCount: 0 })).toBe('NEED_RECHECK');
    expect(lowAccuracyDecision({ ...base, recheckCount: 5 })).toBe('NEED_RECHECK');
    expect(lowAccuracyDecision({ ...base, recheckCount: 5, enabled: false })).toBe('NEED_RECHECK');
    // 오차가 허용치 이하면 엄격 모드여도 해당 없음
    expect(lowAccuracyDecision({ ...base, accuracyMeters: 50, recheckCount: 0 })).toBe('NOT_LOW');
    // strict 미지정(기존 호출)은 예전과 같다
    expect(lowAccuracyDecision({ accuracyMeters: 2800, maxAccuracyMeters: 1000, recheckCount: 1, enabled: true })).toBe('PASS_AFTER_RECHECK');
  });
  it('locationFailureDecision: 엄격 모드면 봐주기도 사유 입력도 없이 항상 차단', () => {
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 1, reason: '지하 기계실이라 GPS 불가', strict: true })).toBe('BLOCK');
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 0, reason: null, strict: true })).toBe('BLOCK');
    // strict 미지정은 예전과 같다
    expect(locationFailureDecision({ priorFailures: 0, graceCount: 0, reason: '지하 기계실이라 GPS 불가' })).toBe('ALLOW_WITH_REASON');
  });
});

describe('퇴근 시 작업기록 완성도(findIncompleteEffort)', () => {
  const on = { enforceDescription: true, enforceContact: true };
  it('내용이 공백뿐이면 DESCRIPTION', () => {
    expect(findIncompleteEffort([{ clientName: 'A', description: '  ', contactId: 'c' }], on)).toEqual({ clientName: 'A', missing: 'DESCRIPTION' });
  });
  it('담당자 id도 이름도 없으면 CONTACT', () => {
    expect(findIncompleteEffort([{ clientName: 'A', description: '점검', contactId: null, contactName: ' ' }], on)).toEqual({ clientName: 'A', missing: 'CONTACT' });
  });
  it('담당자 이름만 있어도 통과, 비어 있는 목록도 통과', () => {
    expect(findIncompleteEffort([{ clientName: 'A', description: '점검', contactName: '김대리' }], on)).toBeNull();
    expect(findIncompleteEffort([], on)).toBeNull();
  });
  it('개별 강제를 끄면 해당 항목은 보지 않는다', () => {
    expect(findIncompleteEffort([{ clientName: 'A', description: '' }], { enforceDescription: false, enforceContact: false })).toBeNull();
  });
});
