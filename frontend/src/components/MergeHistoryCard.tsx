import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * 최근 합치기 기록 (2026-11-01) — 고객사 합치기는 연결된 데이터를 옮기고 원본을 지우는 작업이라, 실수했을 때 되돌릴 수 있게 한다.
 * 합치기 직전 상태가 기록된 건(30일 이내)은 버튼 한 번으로 삭제됐던 고객사와 옮겨졌던 항목을 원래대로 복원한다.
 */
interface MergeRow { auditId: string; createdAt: string; keepName: string; removed: string[]; undoable: boolean; undone: boolean }

function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}

export default function MergeHistoryCard({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<MergeRow[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<MergeRow[]>('/clients/merge-history')
      .then((d) => { setRows(d); setConfirmId(null); })
      .catch((e) => setError(e instanceof Error ? e.message : '합치기 기록을 불러오지 못했습니다.'));
  }
  useEffect(load, []);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('tsb-merge-changed', h);
    return () => window.removeEventListener('tsb-merge-changed', h);
  }, []);

  async function undo(r: MergeRow) {
    if (busyId) return;
    setBusyId(r.auditId);
    setError(null);
    setMessage(null);
    try {
      const d = await apiFetch<{ keep: string; restored: string[] }>('/clients/merge-undo', { method: 'POST', body: JSON.stringify({ auditId: r.auditId }) });
      setMessage(`되돌렸어요. 복원된 고객사: ${d.restored.join(', ')}`);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '되돌리기에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  }

  if (!rows) return error ? <div className="error">{error}</div> : null;
  if (rows.length === 0) return null;
  return (
    <div className="card" data-testid="merge-history-card">
      <h2>🕘 최근 합치기 기록 (30일)</h2>
      <p style={{ fontSize: 13, color: '#495057', lineHeight: 1.6, marginTop: 0 }}>
        실수로 합쳤다면 &quot;되돌리기&quot;로 삭제됐던 고객사와 옮겨졌던 프로젝트·담당자·공수 기록을 원래대로 복원할 수 있어요. 합친 뒤 새로 쌓인 기록은 합쳐진 고객사에 그대로 남아요.
      </p>
      {message && <div style={{ background: '#ebfbee', border: '1px solid #8ce99a', borderRadius: 8, padding: '10px 12px', marginBottom: 8, fontSize: 13, color: '#2b8a3e', fontWeight: 600 }}>{message}</div>}
      {error && <div className="error">{error}</div>}
      {rows.map((r) => (
        <div key={r.auditId} style={{ border: '1px solid #e9ecef', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            {kst(r.createdAt)} · 남긴 고객사 <strong>{r.keepName}</strong> ← 합친 고객사: {r.removed.join(', ')}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {r.undone && <span style={{ fontSize: 13, color: '#2b8a3e' }}>✅ 되돌림 완료</span>}
            {!r.undone && !r.undoable && <span style={{ fontSize: 12.5, color: '#868e96' }}>이전 방식으로 합친 기록 — 자동 되돌리기 불가</span>}
            {!r.undone && r.undoable && confirmId !== r.auditId && (
              <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => setConfirmId(r.auditId)}>되돌리기</button>
            )}
            {!r.undone && r.undoable && confirmId === r.auditId && (
              <>
                <span style={{ fontSize: 13 }}>삭제됐던 고객사를 다시 만들고 옮겨졌던 항목을 원래대로 돌려놓습니다.</span>
                <button style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => undo(r)}>{busyId === r.auditId ? '처리 중...' : '네, 되돌립니다'}</button>
                <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => setConfirmId(null)}>취소</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
