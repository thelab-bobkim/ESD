import { isSuggestionUsed, type Suggestion } from '@/lib/work-log-suggest';

/**
 * 업무일지 제안 칩 — 오늘 작업 기록·진행 중인 작업·배정된 Task를 근거로 서버가 만든 문구를 눌러서 넣는다.
 * 이미 넣은 제안은 ✓ 로 표시되고 다시 눌러도 중복으로 들어가지 않는다.
 */
export default function SuggestionChips({ items, current, onPick, testId }: { items: Suggestion[]; current: string; onPick: (text: string) => void; testId?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div data-testid={testId} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {items.map((s) => {
        const used = isSuggestionUsed(current, s.text);
        return (
          <button
            key={s.text}
            type="button"
            title={s.reason}
            disabled={used}
            onClick={() => onPick(s.text)}
            style={{
              width: 'auto', margin: 0, padding: '5px 10px', fontSize: 11.5, lineHeight: 1.4, textAlign: 'left',
              borderRadius: 14, cursor: used ? 'default' : 'pointer',
              background: used ? 'rgba(34,197,94,0.14)' : '#151c34',
              color: used ? '#86efac' : '#c7d2fe',
              border: `1px solid ${used ? '#1f4a2e' : '#2b3558'}`,
            }}
          >
            {used ? '✓ ' : '+ '}{s.text}
          </button>
        );
      })}
    </div>
  );
}
