import { useState } from 'react';
import { PC_GUIDE_HIDE_DAYS, PC_GUIDE_STEPS, PC_GUIDE_SUMMARY } from '@/lib/pc-location-guide';

/** 2026-10-15: PC로 접속한 직원에게 보여주는 위치 등록 안내 카드(하루 이상 숨길 수 있다). */
export default function PcLocationGuideCard({ onDismiss }: { onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card col-full notice-tint-blue" data-testid="pc-location-guide">
      <strong>💻 PC로 접속 중이세요</strong>
      <div style={{ marginTop: 6, lineHeight: 1.6 }}>{PC_GUIDE_SUMMARY}</div>
      {open && (
        <ol style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.6 }}>
          {PC_GUIDE_STEPS.map((s) => (
            <li key={s.title} style={{ marginBottom: 6 }}>
              <strong>{s.title}</strong>
              <div style={{ opacity: 0.85 }}>{s.detail}</div>
            </li>
          ))}
        </ol>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setOpen((v) => !v)}>
          {open ? '설정 방법 접기' : '설정 방법 보기'}
        </button>
        <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={onDismiss}>
          {PC_GUIDE_HIDE_DAYS}일간 숨기기
        </button>
      </div>
    </div>
  );
}
