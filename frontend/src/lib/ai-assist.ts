import { apiFetch } from '@/lib/api';

/**
 * 2026-10-15: 업무일지 AI 보조(문장 다듬기 · 말/메모로 채우기) 화면용 도우미.
 * 서버(POST /daily-work-log/ai-assist)는 결과를 저장하지 않고 "제안"만 돌려준다 — 적용은 직원이 직접 누른다.
 */
export type AiField = 'issues' | 'followUp' | 'tomorrowPlan';
export type AiSuggestions = Partial<Record<AiField, string>>;
export type AiMode = 'polish' | 'voice';

export const AI_FIELD_LABEL: Record<AiField, string> = {
  issues: '이슈 및 특이사항',
  followUp: '후속조치/미해결 건',
  tomorrowPlan: '내일 예정 업무',
};
export const AI_FIELD_ORDER: AiField[] = ['issues', 'followUp', 'tomorrowPlan'];

export async function requestAiAssist(body: { mode: AiMode; issues?: string; followUp?: string; tomorrowPlan?: string; transcript?: string }): Promise<{ suggestions: AiSuggestions; changed: number }> {
  return apiFetch<{ suggestions: AiSuggestions; changed: number }>('/daily-work-log/ai-assist', { method: 'POST', body: JSON.stringify(body) });
}

/** 간단형에는 후속조치 칸이 없으므로 그 제안은 화면에 보이지 않게 거른다. */
export function visibleSuggestions(s: AiSuggestions, formType: 'SIMPLE' | 'DETAILED'): AiSuggestions {
  const out: AiSuggestions = {};
  for (const k of AI_FIELD_ORDER) {
    const v = (s[k] ?? '').trim();
    if (!v) continue;
    if (k === 'followUp' && formType !== 'DETAILED') continue;
    out[k] = v;
  }
  return out;
}

/** 브라우저의 음성 인식(Web Speech API) 생성자 — 지원하지 않는 브라우저(예: 일부 PC 브라우저·인앱 브라우저)는 null. */
export function getSpeechRecognitionCtor(): any | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}
