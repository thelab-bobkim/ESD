import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';
import MapPickerModal from '@/components/MapPickerModal';

interface ClientRow {
  id: string; name: string; address: string; latitude: number | null; longitude: number | null; hasCoordinates: boolean;
}

export default function AdminClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { lat: string; lng: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [mapTargetId, setMapTargetId] = useState<string | null>(null);

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

  async function saveCoordsValue(id: string, lat: number, lng: number) {
    setSaving(id);
    try {
      await apiFetch(`/clients/${id}/coordinates`, {
        method: 'PUT',
        body: JSON.stringify({ latitude: lat, longitude: lng }),
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
        <h2>사용법</h2>
        <p style={{ fontSize: 13, color: '#495057', lineHeight: 1.6 }}>
          각 고객사 줄의 <strong>"🗺️ 지도에서 찾기"</strong>를 눌러서, 지도에서 주소 검색 후 정확한 위치를
          클릭하면 좌표가 자동으로 저장됩니다. (숫자를 직접 입력하고 싶으면 아래 위도/경도 칸에 입력 후
          "직접입력 저장"을 눌러도 됩니다.)
        </p>
      </div>

      <div className="card">
        <h2>고객사 목록</h2>
        {!clients && <div className="board-empty">불러오는 중...</div>}
        {clients && clients.length === 0 && <div className="board-empty">등록된 고객사가 없습니다.</div>}
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
          onSelect={async (lat, lng) => {
            await saveCoordsValue(mapTargetClient.id, lat, lng);
            setMapTargetId(null);
          }}
        />
      )}
    </div>
  );
}
