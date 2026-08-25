import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';
import MapPickerModal from '@/components/MapPickerModal';

interface ClientRow {
  id: string; name: string; address: string; latitude: number | null; longitude: number | null; hasCoordinates: boolean;
}
interface NewClientDraft { name: string; address: string; lat: number; lng: number; }

export default function AdminClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { lat: string; lng: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [mapTargetId, setMapTargetId] = useState<string | null>(null);
  const [showAddMap, setShowAddMap] = useState(false);
  const [newClientDraft, setNewClientDraft] = useState<NewClientDraft | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    apiFetch<ClientRow[]>('/clients')
      .then((data) => {
        setClients(data);
        const initial: Record<string, { lat: string; lng: string }> = {};
        data.forEach((c) => {
          initial[c.id] = { lat: c.latitude?.toString() ?? '', lng: c.longitude?.toString() ?? '' };
        });
        setEditing(initial);
      })
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
  }

  useEffect(load, []);

  async function saveCoordsValue(id: string, lat: number, lng: number, address?: string) {
    setSaving(id);
    try {
      await apiFetch(`/clients/${id}/coordinates`, {
        method: 'PUT',
        body: JSON.stringify({ latitude: lat, longitude: lng, ...(address ? { address } : {}) }),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장에 실패했습니다.');
    } finally {
      setSaving(null);
    }
  }

  async function saveCoords(id: string) {
    const { lat, lng } = editing[id] ?? { lat: '', lng: '' };
    if (!lat.trim() || !lng.trim()) return;
    await saveCoordsValue(id, Number(lat), Number(lng));
  }

  async function createClient() {
    if (!newClientDraft) return;
    setCreating(true);
    try {
      await apiFetch('/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: newClientDraft.name,
          address: newClientDraft.address,
          latitude: newClientDraft.lat,
          longitude: newClientDraft.lng,
        }),
      });
      setNewClientDraft(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '등록에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  const mapTargetClient = clients?.find((c) => c.id === mapTargetId) ?? null;

  return (
    <div className="admin-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>📍 고객사 위치(좌표) 관리</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/admin/dashboard')}>상황판으로</button>
          <button className="secondary" style={{ width: 'auto' }} onClick={logout}>로그아웃</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>신규 고객사 등록</h2>
          <button style={{ width: 'auto', margin: 0 }} onClick={() => setShowAddMap(true)}>➕ 지도에서 고객사 찾아 등록</button>
        </div>
        <p style={{ fontSize: 13, color: '#495057', lineHeight: 1.6, marginBottom: 0 }}>
          지도에서 고객사명을 검색해서 선택하면, 고객사명과 주소가 자동으로 채워집니다. 확인 후 등록만 누르면 됩니다.
        </p>
      </div>

      {newClientDraft && (
        <div className="card">
          <h2>새 고객사 확인</h2>
          <label className="field-label">고객사명</label>
          <input value={newClientDraft.name} onChange={(e) => setNewClientDraft({ ...newClientDraft, name: e.target.value })} />
          <label className="field-label">주소</label>
          <input value={newClientDraft.address} onChange={(e) => setNewClientDraft({ ...newClientDraft, address: e.target.value })} />
          <p style={{ fontSize: 12, color: '#868e96' }}>좌표: {newClientDraft.lat.toFixed(6)}, {newClientDraft.lng.toFixed(6)}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={creating || !newClientDraft.name.trim()} onClick={createClient}>
              {creating ? '등록 중...' : '이 고객사 등록'}
            </button>
            <button className="secondary" onClick={() => setNewClientDraft(null)}>취소</button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>고객사 목록</h2>
        <p style={{ fontSize: 12, color: '#868e96', marginTop: -6 }}>
          각 줄의 "🗺️ 지도에서 찾기"를 눌러서 좌표를 다시 등록/수정할 수 있습니다.
        </p>
        {!clients && <div className="board-empty">불러오는 중...</div>}
        {clients && clients.length === 0 && <div className="board-empty">등록된 고객사가 없습니다. 위에서 새로 등록해주세요.</div>}
        {clients && clients.length > 0 && (
          <table>
            <thead>
              <tr><th>고객사명</th><th>주소</th><th>위도</th><th>경도</th><th>상태</th><th></th></tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td style={{ fontSize: 12, color: '#868e96' }}>{c.address}</td>
                  <td>
                    <input
                      style={{ margin: 0, width: 100 }}
                      value={editing[c.id]?.lat ?? ''}
                      placeholder="37.5665"
                      onChange={(e) => setEditing((prev) => ({ ...prev, [c.id]: { ...prev[c.id], lat: e.target.value } }))}
                    />
                  </td>
                  <td>
                    <input
                      style={{ margin: 0, width: 100 }}
                      value={editing[c.id]?.lng ?? ''}
                      placeholder="126.9780"
                      onChange={(e) => setEditing((prev) => ({ ...prev, [c.id]: { ...prev[c.id], lng: e.target.value } }))}
                    />
                  </td>
                  <td>{c.hasCoordinates ? <span style={{ color: '#2f9e44' }}>✓ 등록됨</span> : <span style={{ color: '#adb5bd' }}>미등록</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={{ width: 'auto', margin: 0 }} onClick={() => setMapTargetId(c.id)}>
                        🗺️ 지도에서 찾기
                      </button>
                      <button style={{ width: 'auto', margin: 0 }} className="secondary" disabled={saving === c.id} onClick={() => saveCoords(c.id)}>
                        {saving === c.id ? '저장중...' : '직접입력 저장'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {mapTargetClient && (
        <MapPickerModal
          initialAddress={mapTargetClient.address}
          onClose={() => setMapTargetId(null)}
          onSelect={async (lat, lng, address) => {
            await saveCoordsValue(mapTargetClient.id, lat, lng, address);
            setMapTargetId(null);
          }}
        />
      )}

      {showAddMap && (
        <MapPickerModal
          onClose={() => setShowAddMap(false)}
          onSelect={(lat, lng, address, placeName) => {
            setNewClientDraft({ name: placeName || '', address: address || '', lat, lng });
            setShowAddMap(false);
          }}
        />
      )}
    </div>
  );
}
