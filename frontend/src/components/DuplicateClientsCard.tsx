import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * 중복 고객사 정리 (2026-10-13) — 같은 주소로 이름만 다르게 이중 등록된 고객사('생물' / '국립생물자원관' 등)를 찾아 보여주고,
 * 관리자가 "정확한 이름"을 고르면 나머지를 그 이름으로 합친다(직원 배정·도착체크·프로젝트·담당자·과거 공수 기록 이름을 옮긴 뒤 삭제).
 * 자동으로 지우지 않는다. 같은 건물의 다른 회사일 수 있는 경우(주소만 같음)는 '확인 필요'로 표시하고 기본 선택하지 않는다.
 */
interface DupClient {
  id: string; name: string; address: string; hasCoordinates: boolean; looksSameAsSuggested: boolean;
  usage: { assignedUsers: number; checkins: number; projects: number; contacts: number; effortLogs: number };
}
interface DupGroup { key: string; confidence: 'HIGH' | 'LOW'; suggestedKeepId: string; clients: DupClient[] }
interface MergeResult { keep: { id: string; name: string }; removed: string[]; users: number; checkins: number; projects: number; contactsMoved: number; contactsMerged: number; effortRenamed: number; coordinatesCopied?: boolean }

function usageText(u: DupClient['usage']): string {
  const parts: string[] = [];
  if (u.projects) parts.push(`프로젝트 ${u.projects}`);
  if (u.contacts) parts.push(`담당자 ${u.contacts}`);
  if (u.effortLogs) parts.push(`공수기록 ${u.effortLogs}`);
  if (u.checkins) parts.push(`도착체크 ${u.checkins}`);
  if (u.assignedUsers) parts.push(`배정직원 ${u.assignedUsers}`);
  return parts.length ? parts.join(' · ') : '연결된 데이터 없음';
}

export default function DuplicateClientsCard({ onMerged }: { onMerged: () => void }) {
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [remove, setRemove] = useState<Record<string, Set<string>>>({});
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<DupGroup[]>('/clients/duplicates')
      .then((data) => {
        setGroups(data);
        const k: Record<string, string> = {};
        const r: Record<string, Set<string>> = {};
        data.forEach((g) => {
          k[g.key] = g.suggestedKeepId;
          r[g.key] = new Set(g.confidence === 'HIGH' ? g.clients.filter((c) => c.id !== g.suggestedKeepId && c.looksSameAsSuggested).map((c) => c.id) : []);
        });
        setKeep(k);
        setRemove(r);
        setConfirmKey(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '중복 고객사를 불러오지 못했습니다.'));
  }
  useEffect(load, []);

  function chooseKeep(g: DupGroup, id: string) {
    setKeep((p) => ({ ...p, [g.key]: id }));
    setRemove((p) => {
      const next = new Set(p[g.key] ?? []);
      next.delete(id);
      return { ...p, [g.key]: next };
    });
    setConfirmKey(null);
  }

  function toggleRemove(g: DupGroup, id: string) {
    setRemove((p) => {
      const next = new Set(p[g.key] ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...p, [g.key]: next };
    });
    setConfirmKey(null);
  }

  async function merge(g: DupGroup) {
    const keepId = keep[g.key];
    const removeIds = [...(remove[g.key] ?? [])];
    if (!keepId || removeIds.length === 0 || busyKey) return;
    setBusyKey(g.key);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch<MergeResult>('/clients/merge', { method: 'POST', body: JSON.stringify({ keepId, removeIds }) });
      setMessage(`"${res.keep.name}"(으)로 합쳤어요. 삭제: ${res.removed.join(', ')} — 프로젝트 ${res.projects}건·담당자 ${res.contactsMoved + res.contactsMerged}명·공수기록 ${res.effortRenamed}건·배정직원 ${res.users}명 이전.${res.coordinatesCopied ? ' 남긴 고객사에 좌표가 없어 합친 쪽의 좌표를 물려받았어요.' : ''}`);
      load();
      onMerged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '합치기에 실패했습니다.');
    } finally {
      setBusyKey(null);
      setConfirmKey(null);
    }
  }

  if (!groups) return error ? <div className="error">{error}</div> : null;
  if (groups.length === 0 && !message) return null;

  return (
    <div className="card" data-testid="duplicate-clients-card">
      <h2>🔁 중복 고객사 점검 ({groups.length}건)</h2>
      <p style={{ fontSize: 13, color: '#495057', lineHeight: 1.6, marginTop: 0 }}>
        같은 주소로 이름만 다르게 등록된 고객사입니다. <strong>남길 정확한 이름</strong>을 고르면 나머지를 그 이름으로 합칩니다(프로젝트·담당자·공수기록·배정이 남길 쪽으로 옮겨진 뒤 삭제).
        매일 오전 8시(평일)에 중복이 있으면 관리자에게 알림이 갑니다.
      </p>
      {message && <div style={{ background: "#ebfbee", border: "1px solid #8ce99a", borderRadius: 8, padding: "10px 12px", marginBottom: 8, fontSize: 13, color: "#2b8a3e", fontWeight: 600, lineHeight: 1.6 }}>{message}</div>}
      {error && <div className="error">{error}</div>}
      {groups.map((g) => {
        const removeIds = remove[g.key] ?? new Set<string>();
        const keepClient = g.clients.find((c) => c.id === keep[g.key]);
        const removeNames = g.clients.filter((c) => removeIds.has(c.id)).map((c) => c.name);
        return (
          <div key={g.key} style={{ border: '1px solid #e9ecef', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, marginBottom: 6, color: g.confidence === 'HIGH' ? '#e03131' : '#e8590c', fontWeight: 600 }}>
              {g.confidence === 'HIGH' ? '거의 확실한 중복 (이름이 포함 관계이거나 좌표가 같음)' : '확인 필요 — 주소만 같아요. 같은 건물의 다른 회사일 수 있으니 확실할 때만 합치세요.'}
            </div>
            <div className="table-scroll">
              <table style={{ minWidth: 640 }}>
                <thead><tr><th>남길 이름</th><th>합칠 대상</th><th>고객사명</th><th>주소</th><th>좌표</th><th>연결된 데이터</th></tr></thead>
                <tbody>
                  {g.clients.map((c) => (
                    <tr key={c.id}>
                      <td><input type="radio" name={`keep-${g.key}`} style={{ width: 'auto', margin: 0 }} checked={keep[g.key] === c.id} onChange={() => chooseKeep(g, c.id)} aria-label={`${c.name} 남기기`} /></td>
                      <td><input type="checkbox" style={{ width: 'auto', margin: 0 }} disabled={keep[g.key] === c.id} checked={removeIds.has(c.id)} onChange={() => toggleRemove(g, c.id)} aria-label={`${c.name} 합치기`} /></td>
                      <td style={{ fontWeight: keep[g.key] === c.id ? 700 : 400 }}>{c.name}{c.id === g.suggestedKeepId ? ' (추천)' : ''}</td>
                      <td>{c.address}</td>
                      <td>{c.hasCoordinates ? '있음' : <span style={{ color: '#e8590c' }}>없음</span>}</td>
                      <td style={{ fontSize: 12.5 }}>{usageText(c.usage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              {confirmKey !== g.key ? (
                <button style={{ width: 'auto', margin: 0 }} disabled={removeIds.size === 0 || !!busyKey} onClick={() => setConfirmKey(g.key)}>
                  선택한 이름으로 합치기
                </button>
              ) : (
                <>
                  <span style={{ fontSize: 13 }}>
                    <strong>{removeNames.join(', ')}</strong> → <strong>{keepClient?.name}</strong>(으)로 합치고 앞의 고객사는 삭제합니다. 되돌릴 수 없어요.
                  </span>
                  <button style={{ width: 'auto', margin: 0 }} disabled={!!busyKey} onClick={() => merge(g)}>{busyKey === g.key ? '합치는 중...' : '네, 합칩니다'}</button>
                  <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={!!busyKey} onClick={() => setConfirmKey(null)}>취소</button>
                </>
              )}
              {removeIds.size === 0 && <span style={{ fontSize: 12.5, color: '#868e96' }}>합칠 대상을 체크하세요.</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
