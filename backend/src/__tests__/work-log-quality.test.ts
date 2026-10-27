// 업무일지 점검(작성률·내용 품질·공수 일치·활용 가능성) 계산을 DB 없이 검증한다.
import {
  analyzeWorkLogs, assessLog, classifyIssues, clientNamesMatch, splitClients, gradeOf,
  type QualityLogInput, type QualityAttendanceInput, type QualityEffortInput,
} from '../modules/daily-work-log/work-log-quality';

const CLIENTS = ['NH농협은행 의왕', '코스콤', '(주)메타온넷'];

function log(over: Partial<QualityLogInput> = {}): QualityLogInput {
  return {
    userId: 'u1', userName: '홍길동', departmentName: '기술지원팀', dateKey: '2026-10-13', formType: 'SIMPLE',
    visitedClients: null, workContent: null, issues: '특이사항 없음', tomorrowPlan: '코스콤 서버 점검',
    actualEffortMinutes: null, ...over,
  };
}
function eff(over: Partial<QualityEffortInput> = {}): QualityEffortInput {
  return { userId: 'u1', dateKey: '2026-10-13', clientName: '코스콤', minutes: 120, ...over };
}
function att(over: Partial<QualityAttendanceInput> = {}): QualityAttendanceInput {
  return { userId: 'u1', userName: '홍길동', departmentName: '기술지원팀', dateKey: '2026-10-13', completed: true, ...over };
}

describe('classifyIssues', () => {
  it('"이슈 없음"은 정당한 답으로 본다', () => {
    for (const t of ['없음', '특이사항 없음', '특이사항 없습니다.', '이상무', '해당사항 없음']) expect(classifyIssues(t)).toBe('NONE');
  });
  it('구두점·한 글자·반복·자음만은 의미 없는 입력', () => {
    for (const t of ['.', '-', 'ㅇㅇ', 'ㅋㅋㅋ', '', '   ', 'aaaa']) expect(classifyIssues(t)).toBe('JUNK');
  });
  it('구체적인 내용은 작성됨', () => {
    expect(classifyIssues('방화벽 로그 용량 부족으로 정리함')).toBe('WRITTEN');
  });
});

describe('고객사명 비교', () => {
  it('(주)·공백·대소문자를 무시하고 부분 일치를 허용한다', () => {
    expect(clientNamesMatch('메타온넷', '(주)메타온넷')).toBe(true);
    expect(clientNamesMatch('농협', 'NH농협은행 의왕')).toBe(true);
    expect(clientNamesMatch('코스콤', '메타온넷')).toBe(false);
    expect(clientNamesMatch('a', 'abc')).toBe(false); // 한 글자는 비교하지 않음
  });
  it('쉼표·슬래시로 여러 방문지를 나눈다', () => {
    expect(splitClients('코스콤, 메타온넷/ 농협')).toEqual(['코스콤', '메타온넷', '농협']);
    expect(splitClients(null)).toEqual([]);
  });
});

describe('assessLog', () => {
  it('성의 있게 쓴 일지는 100점 GOOD', () => {
    const r = assessLog(
      log({ formType: 'DETAILED', visitedClients: '코스콤', workContent: '코스콤 서버 정기점검 및 로그 정리 수행', issues: '디스크 사용률 85%로 증설 필요', actualEffortMinutes: 120 }),
      [eff()], CLIENTS, false
    );
    expect(r.flags).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.grade).toBe('GOOD');
  });

  it('내일 계획이 "없음"이면 PLAN_WEAK', () => {
    const r = assessLog(log({ tomorrowPlan: '없음' }), [], CLIENTS, false);
    expect(r.flags).toContain('PLAN_WEAK');
    expect(r.score).toBe(75);
  });

  it('휴가 같은 짧지만 분명한 계획은 통과', () => {
    expect(assessLog(log({ tomorrowPlan: '휴가' }), [], CLIENTS, false).flags).not.toContain('PLAN_WEAK');
  });

  it('고객사 작업을 한 날 작업내용이 비면 CONTENT_MISSING, 짧으면 CONTENT_SHORT', () => {
    const base = { visitedClients: '코스콤', actualEffortMinutes: 120 };
    expect(assessLog(log({ ...base, workContent: '' }), [eff()], CLIENTS, false).flags).toContain('CONTENT_MISSING');
    expect(assessLog(log({ ...base, workContent: '점검함' }), [eff()], CLIENTS, false).flags).toContain('CONTENT_SHORT');
  });

  it('작업 기록이 없는 간단형은 작업내용이 비어도 문제 삼지 않는다', () => {
    expect(assessLog(log({ workContent: '' }), [], CLIENTS, false).flags).toEqual([]);
  });

  it('작업 기록의 고객사가 일지 어디에도 없으면 CLIENT_NOT_IN_LOG', () => {
    const r = assessLog(log({ visitedClients: '메타온넷', workContent: '메타온넷 장비 교체 지원 진행', actualEffortMinutes: 120 }), [eff({ clientName: '코스콤' })], CLIENTS, false);
    expect(r.flags).toContain('CLIENT_NOT_IN_LOG');
  });

  it('작업내용에만 고객사가 적혀 있어도 일치로 본다', () => {
    const r = assessLog(log({ workContent: '코스콤 서버 정기점검 및 로그 정리 수행', actualEffortMinutes: 120 }), [eff()], CLIENTS, false);
    expect(r.flags).not.toContain('CLIENT_NOT_IN_LOG');
  });

  it('방문지는 있는데 작업 기록이 전혀 없으면 VISIT_WITHOUT_EFFORT(가벼운 감점)', () => {
    const r = assessLog(log({ visitedClients: '코스콤' }), [], CLIENTS, false);
    expect(r.flags).toContain('VISIT_WITHOUT_EFFORT');
    expect(r.score).toBe(95);
  });

  it('등록되지 않은 방문지는 CLIENT_UNREGISTERED, 매칭 개수도 센다', () => {
    const r = assessLog(log({ visitedClients: '코스콤, 처음보는회사' }), [eff()], CLIENTS, false);
    expect(r.flags).toContain('CLIENT_UNREGISTERED');
    expect(r.clientCount).toBe(2);
    expect(r.matchedClientCount).toBe(1);
  });

  it('전날과 같은 내용이면 COPY_OF_PREVIOUS', () => {
    expect(assessLog(log(), [], CLIENTS, true).flags).toContain('COPY_OF_PREVIOUS');
  });

  it('일지의 공수 스냅샷이 작업 기록 합계와 1시간 넘게 다르면 EFFORT_SNAPSHOT_DIFF', () => {
    const r = assessLog(log({ visitedClients: '코스콤', workContent: '코스콤 서버 정기점검 및 로그 정리 수행', actualEffortMinutes: 20 }), [eff({ minutes: 240 })], CLIENTS, false);
    expect(r.flags).toContain('EFFORT_SNAPSHOT_DIFF');
  });

  it('점수는 0 아래로 내려가지 않고 등급 경계가 맞는다', () => {
    const r = assessLog(
      log({ formType: 'DETAILED', issues: '.', tomorrowPlan: '.', workContent: '', visitedClients: '모르는곳', actualEffortMinutes: 0 }),
      [eff()], CLIENTS, true
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.grade).toBe('POOR');
    expect(gradeOf(80)).toBe('GOOD');
    expect(gradeOf(79)).toBe('FAIR');
    expect(gradeOf(50)).toBe('FAIR');
    expect(gradeOf(49)).toBe('POOR');
  });
});

describe('analyzeWorkLogs', () => {
  it('작성률은 퇴근까지 마친 날 대비 일지가 있는 날로 계산하고 미작성일을 알려준다', () => {
    const attendance = [
      att({ dateKey: '2026-10-12' }), att({ dateKey: '2026-10-13' }), att({ dateKey: '2026-10-14' }),
      att({ dateKey: '2026-10-15', completed: false }), // 아직 퇴근 전 — 분모에서 제외
      att({ userId: 'u2', userName: '김철수', dateKey: '2026-10-13' }),
    ];
    const logs = [log({ dateKey: '2026-10-12' }), log({ dateKey: '2026-10-13' }), log({ userId: 'u2', userName: '김철수', dateKey: '2026-10-13' })];
    const s = analyzeWorkLogs(logs, attendance, [], CLIENTS);
    expect(s.totals.completedDays).toBe(4);
    expect(s.totals.logDays).toBe(3);
    expect(s.totals.coverageRate).toBe(75);
    const hong = s.users.find((u) => u.userName === '홍길동')!;
    expect(hong.completedDays).toBe(3);
    expect(hong.logDays).toBe(2);
    expect(hong.missingDates).toEqual(['2026-10-14']);
    // 미작성이 있는 직원이 위로
    expect(s.users[0].userName).toBe('홍길동');
  });

  it('일지가 한 건도 없는 직원도 목록에 나온다', () => {
    const s = analyzeWorkLogs([], [att(), att({ dateKey: '2026-10-14' })], [], CLIENTS);
    expect(s.users).toHaveLength(1);
    expect(s.users[0].coverageRate).toBe(0);
    expect(s.users[0].avgScore).toBeNull();
    expect(s.totals.avgScore).toBeNull();
  });

  it('같은 직원의 전날 복사본을 찾아내고 부서·일자별로 묶는다', () => {
    const same = { workContent: '코스콤 서버 정기점검 및 로그 정리 수행', tomorrowPlan: '코스콤 서버 점검 이어서 진행' };
    const logs = [
      log({ dateKey: '2026-10-12', ...same }),
      log({ dateKey: '2026-10-13', ...same }),
      log({ userId: 'u2', userName: '김철수', departmentName: '영업팀', dateKey: '2026-10-13', ...same }), // 다른 직원 — 복사 아님
    ];
    const attendance = [att({ dateKey: '2026-10-12' }), att({ dateKey: '2026-10-13' }), att({ userId: 'u2', userName: '김철수', departmentName: '영업팀', dateKey: '2026-10-13' })];
    const s = analyzeWorkLogs(logs, attendance, [], CLIENTS);
    const copy = s.byFlag.find((f) => f.flag === 'COPY_OF_PREVIOUS')!;
    expect(copy.count).toBe(1);
    expect(copy.userCount).toBe(1);
    expect(s.departments.map((d) => d.name).sort()).toEqual(['기술지원팀', '영업팀']);
    expect(s.daily.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13']);
    expect(s.daily[1].completedDays).toBe(2);
  });

  it('활용 가능 비율·고객사 매칭률·낮은 점수 샘플을 계산한다', () => {
    const good = log({ dateKey: '2026-10-12', visitedClients: '코스콤', workContent: '코스콤 서버 정기점검 및 로그 정리 수행', issues: '디스크 증설 필요', actualEffortMinutes: 120 });
    const bad = log({ dateKey: '2026-10-13', formType: 'DETAILED', issues: '.', tomorrowPlan: '.', workContent: '', visitedClients: '모르는곳' });
    const s = analyzeWorkLogs([good, bad], [att({ dateKey: '2026-10-12' }), att({ dateKey: '2026-10-13' })], [eff({ dateKey: '2026-10-12' })], CLIENTS);
    expect(s.totals.good).toBe(1);
    expect(s.totals.poor).toBe(1);
    expect(s.totals.usableRate).toBe(50);
    expect(s.totals.clientMatchRate).toBe(50);
    expect(s.samples).toHaveLength(1);
    expect(s.samples[0].dateKey).toBe('2026-10-13');
    expect(s.samples[0].flags).toEqual(expect.arrayContaining(['PLAN_WEAK', 'ISSUES_JUNK']));
  });

  it('긴 본문은 80자로 잘라서 내려준다', () => {
    const long = 'ㄱ나다라마바사아자차카타파하'.repeat(10);
    const bad = log({ issues: '.', tomorrowPlan: '.', workContent: long, formType: 'DETAILED' });
    const s = analyzeWorkLogs([bad], [att()], [], CLIENTS);
    expect(s.samples[0].workContent.length).toBeLessThanOrEqual(81);
  });

  it('입력이 모두 비어도 오류 없이 빈 요약을 낸다', () => {
    const s = analyzeWorkLogs([], [], [], []);
    expect(s.totals.coverageRate).toBeNull();
    expect(s.users).toEqual([]);
    expect(s.byFlag).toEqual([]);
  });
});
