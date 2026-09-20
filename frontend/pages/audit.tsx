import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, clearToken } from '@/lib/api';

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
 * "감사인 전용 화면"(2026-09-20, 대표이사 요청) — /audit-login으로 로그인한 뒤 도착하는
 * 유일한 화면이다. 일반 관리자 화면(AdminHeader/관리자 대시보드 등)과 완전히 분리되어 있고,
 * 이 화면 자체도 다른 어느 메뉴에서도 링크로 연결되지 않는다. 이 로그인으로 발급된 토큰은
 * roles=['AUDITOR']만 갖고 있어서, 애초에 다른 관리자 API를 호출할 수도 없다(403).
 */
export default function AuditPage() {
  const router = useRouter();
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
      if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰') || err.message.includes('권한'))) {
        clearToken();
        router.push('/audit-login');
        return;
      }
      setError(err instanceof Error ? err.message : '불러오기에 실패했습니다.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function logout() {
    clearToken();
    router.push('/audit-login');
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) => !q || e.userName.toLowerCase().includes(q) || e.employeeNo.toLowerCase().includes(q) || e.department.toLowerCase().includes(q)
    );
  }, [entries, search]);

  return (
    <div className="admin-shell">
      <Head>
        <title>DSTI-TSB 감사</title>
      </Head>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>🛰️ 재택 위치 감사</h1>
        <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={logout}>🚪 로그아웃</button>
      </div>
      <p className="admin-page-subtitle">
        재택(원격) 근무 등록 시 캡처된 GPS 좌표입니다. 이 화면은 지정된 감사인 계정으로만 접근할 수 있습니다.
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
