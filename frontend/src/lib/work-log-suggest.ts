/**
 * 2026-10-15: 업무일지 제안 칩 도우미(순수 함수) — 서버(GET /daily-work-log/draft)가 내려준 제안 문구를
 * 입력칸에 "추가"하고, 이미 넣은 제안인지 판단한다. 제안은 직원이 눌러야만 들어가며 언제든 고쳐 쓸 수 있다.
 */
export interface Suggestion { text: string; reason: string }
export interface DraftSuggestions { issues: Suggestion[]; followUp: Suggestion[]; tomorrowPlan: Suggestion[] }

function squash(s: string): string {
  return (s ?? '').replace(/\s+/g, '');
}

/** 이미 입력칸에 들어 있는 제안인가(공백 차이는 무시, 뒤에 이어 적은 내용이 있어도 포함이면 사용한 것으로 본다). */
export function isSuggestionUsed(current: string, text: string): boolean {
  const t = squash(text);
  return t.length > 0 && squash(current).includes(t);
}

/** 제안 문구를 입력칸 끝에 줄바꿈으로 추가한다. 비어 있으면 그대로 넣고, 이미 있으면 바꾸지 않는다. */
export function appendSuggestion(current: string, text: string): string {
  if (isSuggestionUsed(current, text)) return current;
  const base = (current ?? '').replace(/\s+$/, '');
  return base ? `${base}\n${text}` : text;
}
