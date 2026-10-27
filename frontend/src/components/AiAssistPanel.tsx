import { useEffect, useRef, useState } from 'react';
import {
  AI_FIELD_LABEL, AI_FIELD_ORDER, getSpeechRecognitionCtor, requestAiAssist, visibleSuggestions,
  type AiField, type AiMode, type AiSuggestions,
} from '@/lib/ai-assist';

/**
 * 퇴근 창의 "AI 도우미" — ① 적은 문장 다듬기 ② 말/메모를 이슈·후속조치·내일 예정으로 나눠 채우기.
 * AI 결과는 미리보기로만 보여주고, 직원이 "적용"을 눌러야 입력칸에 들어간다(자동으로 덮어쓰지 않는다).
 */
interface Props {
  formType: 'SIMPLE' | 'DETAILED';
  values: Record<AiField, string>;
  onApply: (field: AiField, text: string, mode: AiMode) => void;
}

const btn: React.CSSProperties = { width: 'auto', margin: 0, padding: '6px 12px', fontSize: 12, borderRadius: 14, background: '#1b2547', color: '#c7d2fe', border: '1px solid #2b3558', cursor: 'pointer' };
const box: React.CSSProperties = { background: '#f5f7fb', border: '1px solid #d5dbe6', borderRadius: 10, padding: '10px 12px', marginTop: 8, fontSize: 12.5, lineHeight: 1.6 };

export default function AiAssistPanel({ formType, values, onApply }: Props) {
  const [busy, setBusy] = useState<AiMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ mode: AiMode; items: AiSuggestions } | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [memo, setMemo] = useState('');
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const baseRef = useRef('');
  const speechSupported = typeof window !== 'undefined' && !!getSpeechRecognitionCtor();

  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* 이미 멈춤 */ } }, []);

  async function run(mode: AiMode) {
    if (busy) return;
    setError(null);
    setPreview(null);
    setBusy(mode);
    try {
      const body = mode === 'polish'
        ? { mode, issues: values.issues, followUp: formType === 'DETAILED' ? values.followUp : '', tomorrowPlan: values.tomorrowPlan }
        : { mode, transcript: memo };
      const res = await requestAiAssist(body);
      const items = visibleSuggestions(res.suggestions ?? {}, formType);
      if (Object.keys(items).length === 0) setError(mode === 'polish' ? '더 다듬을 내용이 없어요. 지금 문장 그대로도 좋아요.' : '나눠 채울 내용을 찾지 못했어요. 조금 더 구체적으로 말씀해 주세요.');
      else setPreview({ mode, items });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI가 지금 응답하지 못했어요. 직접 입력해주세요.');
    } finally {
      setBusy(null);
    }
  }

  function apply(field: AiField) {
    if (!preview) return;
    const text = preview.items[field];
    if (!text) return;
    onApply(field, text, preview.mode);
    const rest = { ...preview.items };
    delete rest[field];
    setPreview(Object.keys(rest).length > 0 ? { mode: preview.mode, items: rest } : null);
  }

  function applyAll() {
    if (!preview) return;
    for (const f of AI_FIELD_ORDER) if (preview.items[f]) onApply(f, preview.items[f] as string, preview.mode);
    setPreview(null);
  }

  function toggleListening() {
    if (listening) { try { recRef.current?.stop(); } catch { /* noop */ } return; }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.continuous = true;
    baseRef.current = memo.trim();
    rec.onresult = (ev: any) => {
      let text = '';
      for (let i = 0; i < ev.results.length; i += 1) text += ev.results[i][0].transcript;
      setMemo(`${baseRef.current}${baseRef.current ? ' ' : ''}${text}`.trim());
    };
    rec.onerror = (ev: any) => {
      setError(ev?.error === 'not-allowed' ? '마이크 사용이 허용되지 않았어요. 브라우저 설정에서 마이크를 허용하거나 글로 적어주세요.' : '음성을 인식하지 못했어요. 다시 시도하거나 글로 적어주세요.');
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setError(null);
    try { rec.start(); setListening(true); } catch { setListening(false); }
  }

  return (
    <div data-testid="ai-assist" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" data-testid="ai-polish" style={btn} disabled={busy !== null} onClick={() => run('polish')}>
          {busy === 'polish' ? '다듬는 중…' : '✨ 문장 다듬기'}
        </button>
        <button type="button" data-testid="ai-voice-toggle" style={btn} disabled={busy !== null} onClick={() => setVoiceOpen((v) => !v)}>
          🎤 말·메모로 채우기
        </button>
      </div>

      {voiceOpen && (
        <div style={box}>
          <div style={{ color: '#5b6478', marginBottom: 6 }}>
            오늘 한 일, 문제, 내일 할 일을 편하게 말하거나 적어주세요. AI가 세 칸으로 나눠 제안해 드려요.
          </div>
          <textarea
            data-testid="ai-memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="예: 오늘 코스콤 점검 끝났고 디스크 하나 교체했어요. 내일은 이어서 로그 정리합니다."
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, background: '#ffffff', color: '#1f2937', border: '1px solid #d5dbe6', fontFamily: 'inherit', fontSize: 13, minHeight: 70, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {speechSupported ? (
              <button type="button" data-testid="ai-mic" style={{ ...btn, background: listening ? '#7f1d1d' : '#1b2547' }} onClick={toggleListening}>
                {listening ? '⏹ 말하기 멈춤' : '🎤 말하기'}
              </button>
            ) : (
              <span data-testid="ai-no-speech" style={{ fontSize: 11.5, color: '#fbbf24' }}>이 브라우저는 음성 입력을 지원하지 않아요. 글로 적어주세요(휴대폰 Chrome·Safari 권장).</span>
            )}
            <button type="button" data-testid="ai-voice-run" style={btn} disabled={busy !== null || memo.replace(/\s+/g, '').length < 5} onClick={() => run('voice')}>
              {busy === 'voice' ? '정리하는 중…' : '✨ AI로 나눠 채우기'}
            </button>
          </div>
          {speechSupported && <div style={{ fontSize: 11, color: '#8a93a8', marginTop: 6 }}>음성은 브라우저(휴대폰)의 음성 인식 서비스를 거쳐 글로 바뀝니다.</div>}
        </div>
      )}

      {error && <div data-testid="ai-error" style={{ ...box, color: '#fbbf24', borderColor: '#4a3a12' }}>{error}</div>}

      {preview && (
        <div data-testid="ai-preview" style={{ ...box, borderColor: '#2b3558' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>✨ AI 제안 <span style={{ fontWeight: 400, color: '#5b6478' }}>— 확인하고 "적용"을 눌러야 입력돼요</span></div>
          {AI_FIELD_ORDER.filter((f) => preview.items[f]).map((f) => (
            <div key={f} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11.5, color: '#5b6478' }}>{AI_FIELD_LABEL[f]}</div>
              {preview.mode === 'polish' && values[f].trim() && <div style={{ fontSize: 11.5, color: '#8a93a8', textDecoration: 'line-through', whiteSpace: 'pre-wrap' }}>{values[f]}</div>}
              <div style={{ whiteSpace: 'pre-wrap', color: '#1f2937' }}>{preview.items[f]}</div>
              <button type="button" data-testid={`ai-apply-${f}`} style={{ ...btn, marginTop: 4, padding: '4px 10px' }} onClick={() => apply(f)}>
                {preview.mode === 'polish' ? '이 문장으로 바꾸기' : '입력칸에 넣기'}
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" data-testid="ai-apply-all" style={btn} onClick={applyAll}>모두 적용</button>
            <button type="button" data-testid="ai-dismiss" style={{ ...btn, background: 'transparent' }} onClick={() => setPreview(null)}>닫기</button>
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#8a93a8', marginTop: 6 }}>AI는 입력한 문장만 정리해요. 적용하기 전에 내용이 맞는지 꼭 확인하세요.</div>
    </div>
  );
}
