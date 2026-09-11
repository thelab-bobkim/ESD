import { useState } from 'react';
import { apiFetch } from '@/lib/api';

const CATEGORIES: { value: 'BUG' | 'UX' | 'POLICY' | 'OTHER'; label: string }[] = [
  { value: 'BUG', label: '🐞 버그/오류' },
  { value: 'UX', label: '💡 불편한 점' },
  { value: 'POLICY', label: '📋 정책 관련' },
  { value: 'OTHER', label: '💬 기타' },
];

/**
 * TSB-Ver3.1: 파일럿 피드백 기능 — 이전엔 DB 모델(PilotFeedback)과 백엔드 API(POST /pilot/feedback)만
 * 있고 실제로 이걸 등록할 화면이 어디에도 없어서 파일럿 기간 내내 등록 건수가 0건이었다(2026-09-11
 * 개선 제안서 참고). 홈 화면에서 바로 접근 가능한 버튼 + 간단한 입력 모달을 추가한다.
 */
export default function PilotFeedbackButton() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<'BUG' | 'UX' | 'POLICY' | 'OTHER'>('UX');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setCategory('UX');
    setContent('');
    setError(null);
    setDone(false);
  }

  async function submit() {
    if (content.trim().length < 5) {
      setError('내용을 5자 이상 입력해주세요.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch('/pilot/feedback', {
        method: 'POST',
        body: JSON.stringify({ category, content: content.trim() }),
      });
      setDone(true);
      setContent('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '전송에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        className="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        💬 불편한 점 · 의견 보내기
      </button>

      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, maxWidth: 440, width: '100%' }}>
            {done ? (
              <>
                <h2 style={{ marginTop: 0 }}>✅ 소중한 의견 감사합니다!</h2>
                <p style={{ fontSize: 13, color: '#495057' }}>보내주신 내용은 운영팀이 확인하고 개선에 반영합니다.</p>
                <button onClick={() => setOpen(false)}>닫기</button>
              </>
            ) : (
              <>
                <h2 style={{ marginTop: 0 }}>💬 불편한 점 · 의견 보내기</h2>
                <p style={{ fontSize: 13, color: '#495057', marginTop: -4 }}>
                  버그, 불편했던 점, 정책 관련 의견 등 무엇이든 편하게 남겨주세요. 운영팀만 확인합니다.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className={category === c.value ? undefined : 'secondary'}
                      style={{ width: 'auto', margin: 0, fontSize: 13, padding: '6px 12px' }}
                      onClick={() => setCategory(c.value)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <textarea
                  className="detail-textarea"
                  rows={4}
                  placeholder="예: 정정 사유를 매번 직접 타이핑해야 해서 번거로워요."
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
                {error && <div className="error">{error}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button disabled={submitting} onClick={submit}>
                    {submitting ? '전송 중...' : '보내기'}
                  </button>
                  <button className="secondary" onClick={() => setOpen(false)}>취소</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
