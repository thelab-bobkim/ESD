/**
 * 2026-10-12: 업무일지 입력 품질 규칙(순수 함수 — 프론트 frontend/src/lib/work-log-rules.ts 와 동일하게 유지).
 *
 * 퇴근 로그 점검 결과 "내일 예정 업무"에 "." / "없음" / "미정" 같은 의미 없는 값이 많이 들어와
 * 다음 날 업무 파악에 쓸 수 없었다. 구두점·공백을 뺀 글자가 3자 이상이어야 통과시키되,
 * 실제로 짧을 수밖에 없는 정당한 답(휴가·반차 등)은 허용한다.
 */

export const MIN_PLAN_LENGTH = 3;

/** 2글자라도 그 자체로 의미가 분명한 답 — "내일은 쉽니다/나가지 않습니다" 류. */
const SHORT_PLAN_ALLOWLIST = new Set([
  '휴가', '휴일', '휴무', '주말', '연차', '반차', '대휴', '연휴', '출장', '외근', '재택', '교육', '상주',
]);

/** 3글자 이상이어도 내용이 없는 대표적인 회피 답변(구두점·공백 제거 후 정확히 일치할 때만). */
const FILLER_PLANS = new Set([
  '없음', '없습니다', '없어요', '미정', '미정입니다', '미정이다', '모름', '해당없음', '해당사항없음', '특이사항없음',
  '추후결정', '추후공지', '추후미정', '추후에', '내일미정', '내일없음', '계획없음', '일정없음', '업무없음',
]);

export function normalizePlanText(text: string): string {
  return (text ?? '').replace(/[\p{P}\p{S}\s]/gu, '');
}

/** 내일 예정 업무가 "의미 있는 입력"인지 판정한다. */
export function isMeaningfulPlan(text: string): boolean {
  const s = normalizePlanText(text);
  if (!s) return false;
  if (SHORT_PLAN_ALLOWLIST.has(s)) return true;
  if (s.length < MIN_PLAN_LENGTH) return false;
  if (FILLER_PLANS.has(s)) return false;
  // 같은 글자 반복("ㅋㅋㅋ", "aaa")이나 자음/모음만으로 이뤄진 값("ㅇㅇㅇ")은 내용으로 보지 않는다.
  if (/^(.)\1*$/u.test(s)) return false;
  if (/^[ㄱ-ㆎ]+$/u.test(s)) return false;
  return true;
}

export const PLAN_RULE_MESSAGE =
  '내일 예정 업무를 3글자 이상 구체적으로 입력해주세요. (예: "코스콤 서버 점검" — 쉬는 날이면 "휴가"처럼 써도 됩니다)';
