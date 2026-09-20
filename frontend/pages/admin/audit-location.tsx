import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

interface RemoteAuditEntry {
  id: string;
  changedAt: string;
  userName: string;
  employeeNo: string;
  department: string;
  latitude: number | null;
  longitude: number | null;
  note: string | null;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * "재택 위치 감사" 화면(2026-09-20, 대표이사 요청).
 *
 * 재택(원격) 근무 등록 시 GPS 캡처는 필수가 됐지만(2026-09-20 "GPS 캡처만 필수화" 정책), 등록된
 * 좌표가 없어(집 주소를 서버에 저장하지 않기로 함) 실시간으로 "어디인지"는 판단하지 않는다.
 * 그 대신 원본 좌표를 이 화면에서만(감사인 권한 전용, /admin/auditors에서 개별 부여) 사후에
 * 확인할 수 있게 해서, 근무태만 의심 등 필요할 때만 감사팀이 들여다볼 수 있게 했다.
 *
 * 좌표는 보관기간(기본 30일, 서버 REMOTE_AUDIT_COORD_RETENTION_DAYS)이 지나면 자동삭제되므로,
 * 그보다 오래된 기록은 이 화면에 나타나지 않는다 — 위치정보보호법상 목적 달성 시 즉시파기 원칙.
 */
export default function AdminAuditLocationPage() {
  const [entries, setEntries] = useState<RemoteAuditEntry[] | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  async function load() {
    setError(null);
    try {
      const res = await apiFetch<{ retentionDays: number; entries: RemoteAuditEntry[] }>('/audit-location/remote');
      setEntries(res.entries);
      setRetentionDays(res.retentionDays);
    } catch (err) {
      setError(err instanceof Error ? err.message : '불러오기에 실패했습니다.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) => !q || e.userName.toLowerCase().includes(q) || e.employeeNo.toLowerCase().includes(q) || e.department.toLowerCase().includes(q)
    );
  }, [entries, search]);

  return (
    <div className="admin-shell">
      <AdminHeader title="재택 위치 감사" />
      <p className="admin-page-subtitle">
        재택(원격) 근무 등록 시 캡처된 GPS 좌표입니다. 이 화면은 감사인 권한을 부여받은 계정에만 보이며,
        일반 관리자에게는 노출되지 않습니다.
        {retentionDays != null && ` 보관기간은 ${retentionDays}일이며, 그보다 오래된 기록은 자동삭제되어 나타나지 않습니다.`}
      </p>
      {error && <div className="error">{error}</div>}

      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-label">조회된 기록</div>
          <div className="stat-value">{entries?.length ?? 0}<small>건</small></div>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="text"
          placeholder="이름·사번·부서 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="spacer" />
        <button onClick={load}>새로고침</button>
      </div>

      {!entries && !error && <div className="board-empty">불러오는 중...</div>}

      {entries && (
        <div className="card">
          <div className="table-scroll">
            <table className="att-table">
              <thead>
                <tr>
                  <th>등록 시각</th>
                  <th>이름</th>
                  <th>사번</th>
                  <th>부서</th>
                  <th>메모</th>
                  <th>위치</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDateTime(e.changedAt)}</td>
                    <td>{e.userName}</td>
                    <td className="num">{e.employeeNo}</td>
                    <td>{e.department}</td>
                    <td>{e.note ?? ''}</td>
                    <td>
                      {e.latitude != null && e.longitude != null ? (
                        <a
                          href={`https://www.google.com/maps?q=${e.latitude},${e.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#4263eb', fontWeight: 600, textDecoration: 'none' }}
                        >
                          🗺️ 지도에서 보기
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--dsti-text-muted, #868e96)' }}>
                      표시할 기록이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
