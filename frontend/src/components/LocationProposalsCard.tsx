import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * 고객사 위치 수정 신청 (2026-10-13) — 직원이 앱에서 "등록된 고객사 위치가 실제와 달라요"라고 올린 신청을 관리자가 확인해 처리한다.
 * 승인하면 신청한 직원들 위치의 평균으로 그 고객사의 등록 좌표가 바뀌고 직원에게 알림이 간다. 반려하면 좌표는 그대로다.
 * 같은 건물의 다른 지점이면 승인 대신 반려하고 새 고객사로 등록한다.
 */
interface Proposal {
  id: string; clientId: string; clientName: string; clientExists: boolean; address: string; createdAt: string;
  userNames: string[]; userCount: number; requestCount: number; notes: string[];
  distanceFromRegisteredMeters: number | null; proposedLat: number; proposedLng: number; registeredLat: number | null; registeredLng: number | null;
}

function fmtDist(m: number | null): string {
  if (m == null) return '-';
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}
function kstDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}

export default function LocationProposalsCard({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<Proposal[]>('/clients/location-proposals')
      .then((d) => { setItems(d); setConfirm(null); setReason(''); })
      .catch((e) => setError(e instanceof Error ? e.message : '위치 수정 신청을 불러오지 못했습니다.'));
  }
  useEffect(load, []);

  async function run(p: Proposal, action: 'approve' | 'reject') {
    if (busyId) return;
    setBusyId(p.id);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/clients/location-proposals/${p.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'reject' ? { reason: reason.trim() || undefined } : {}),
      });
      setMessage(action === 'approve' ? `'${p.clientName}' 위치를 제안 위치로 바꿨어요. 신청한 직원에게 알림을 보냈어요.` : `'${p.clientName}' 신청을 반려했어요. 신청한 직원에게 알림을 보냈어요.`);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리에 실패했습니다.');
      load();
    } finally {
      setBusyId(null);
    }
  }

  if (!items) return error ? <div className="error">{error}</div> : null;
  if (items.length === 0 && !message) return null;

  return (
    <div className="card" data-testid="location-proposals-card">
      <h2>📨 고객사 위치 수정 신청 ({items.length}건)</h2>
      <p style={{ fontSize: 13, color: '#495057', lineHeight: 1.6, marginTop: 0 }}>
        직원이 현장에서 &quot;등록된 고객사 위치가 실제와 달라요&quot;라고 올린 신청입니다. 승인하면 제안 위치(신청한 직원들 위치의 평균)로 고객사 위치가 바뀌어요.
        1명만 올린 신청이나 등록 위치와 많이 차이 나는 신청은 지도에서 직접 확인한 뒤 처리하세요. 같은 건물의 다른 지점이라면 반려하고 새 고객사로 등록하세요.
      </p>
      {message && <div style={{ background: '#ebfbee', border: '1px solid #8ce99a', borderRadius: 8, padding: '10px 12px', marginBottom: 8, fontSize: 13, color: '#2b8a3e', fontWeight: 600 }}>{message}</div>}
      {error && <div className="error">{error}</div>}
      {items.map((p) => {
        const far = (p.distanceFromRegisteredMeters ?? 0) > 1000;
        const mapProposed = `https://map.kakao.com/link/map/제안위치,${p.proposedLat},${p.proposedLng}`;
        const mapRegistered = p.registeredLat != null && p.registeredLng != null ? `https://map.kakao.com/link/map/등록위치,${p.registeredLat},${p.registeredLng}` : null;
        const open = confirm?.id === p.id ? confirm.action : null;
        return (
          <div key={p.id} style={{ border: '1px solid #e9ecef', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontWeight: 700 }}>{p.clientName}{!p.clientExists && <span style={{ color: '#e03131', fontWeight: 400 }}> (삭제된 고객사)</span>}</div>
            <div style={{ fontSize: 12.5, color: '#868e96' }}>{p.address || '주소 없음'}</div>
            <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.7 }}>
              신청: <strong>{p.userCount}명</strong> ({p.userNames.join(', ')}) · {p.requestCount}건 · 최근 {kstDate(p.createdAt)}<br />
              등록 위치와의 차이: <strong style={{ color: far ? '#e03131' : undefined }}>{fmtDist(p.distanceFromRegisteredMeters)}</strong>
              {far && ' — 많이 떨어져 있어요. 다른 지점일 수 있으니 지도로 확인하세요.'}
              {p.userCount < 2 && <span style={{ color: '#e8590c' }}> · 1명만 신청 — 직접 확인을 권장해요.</span>}
              {p.notes.length > 0 && <><br />남긴 말: {p.notes.join(' / ')}</>}
              <br />
              <a href={mapProposed} target="_blank" rel="noreferrer">제안 위치 지도 보기</a>
              {mapRegistered && <> · <a href={mapRegistered} target="_blank" rel="noreferrer">현재 등록 위치 지도 보기</a></>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              {open === null && (
                <>
                  <button style={{ width: 'auto', margin: 0 }} disabled={!p.clientExists || !!busyId} onClick={() => setConfirm({ id: p.id, action: 'approve' })}>제안 위치로 변경(승인)</button>
                  <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => setConfirm({ id: p.id, action: 'reject' })}>반려</button>
                </>
              )}
              {open === 'approve' && (
                <>
                  <span style={{ fontSize: 13 }}><strong>{p.clientName}</strong>의 등록 위치를 제안 위치로 바꿉니다. 이 고객사로 등록하는 모든 직원의 위치 대조 기준이 바뀌어요.</span>
                  <button style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => run(p, 'approve')}>{busyId === p.id ? '처리 중...' : '네, 변경합니다'}</button>
                  <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => setConfirm(null)}>취소</button>
                </>
              )}
              {open === 'reject' && (
                <>
                  <input style={{ margin: 0, width: 220 }} placeholder="반려 사유 (선택, 직원에게 전달돼요)" maxLength={100} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => run(p, 'reject')}>{busyId === p.id ? '처리 중...' : '반려 확정'}</button>
                  <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={!!busyId} onClick={() => setConfirm(null)}>취소</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
