import { isMeaningfulPlan, normalizePlanText } from '../modules/daily-work-log/work-log-rules';

describe('isMeaningfulPlan (내일 예정 업무 최소 글자 규칙)', () => {
  test.each([
    '코스콤 서버 점검',
    '고객사 정기점검',
    '  OO건 이어서 진행  ',
    '휴가',
    '반차',
    '연차.',
    '출장',
    '외근',
    '재택',
    '교육',
    '상주',
    '대휴',
    '주말',
    '휴무!',
    'DB 점검',
    '1) 점검',
  ])('통과: %s', (t) => {
    expect(isMeaningfulPlan(t)).toBe(true);
  });

  test.each([
    '',
    '   ',
    '.',
    '...',
    '-',
    '없음',
    '없음.',
    '미정',
    '미 정',
    'ㅇㅇ',
    'ab',
    '네',
    '없습니다',
    '미정입니다',
    '해당 없음',
    '추후 결정',
    'ㅋㅋㅋ',
    'ㅇㅇㅇ',
    'aaaa',
    '....없음',
  ])('거절: "%s"', (t) => {
    expect(isMeaningfulPlan(t)).toBe(false);
  });

  test('구두점·기호·공백을 뺀 글자로 센다', () => {
    expect(normalizePlanText(' 점 검 . ! ')).toBe('점검');
    expect(isMeaningfulPlan('점 검')).toBe(false); // 2글자
    expect(isMeaningfulPlan('점 검 .')).toBe(false);
    expect(isMeaningfulPlan('점검 확인')).toBe(true); // 4글자
  });
});
