import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

interface AuditorCandidate {
  id: string;
  name: string;
  employeeNo: string;
  department: { id: string; name: string };
  isAuditor: boolean;
}

/**
 * "감사인" 권한 관리 화면(2026-09-20, 대표이사 요청).
 *
 * 재택(원격) 근무 등록 시 캡처되는 GPS 좌표는 일반 관리자(HR_ADMIN/SYSTEM_ADMIN)에게도 보이지
 * 않고, 여기서 개별로 지정한 계정만 볼 수 있다(/admin/audit-location 화면). SYSTEM_ADMIN 전용
 * 화면이며, board-scope.tsx와 같은 형태(검색 + 체크박스 토글)로 구성했다.
 */
export default function AdminAuditorsPage() {
  const [users, setUsers] = useState<AuditorCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  async function load() {
    setError(null);
    try {
      const res = await apiFetch<{ users: AuditorCandidate[]; auditorRoleReady: boolean }>('/users/auditors');
      setUsers(res.users);
      if (!res.auditorRoleReady) {
        setError('AUDITOR 역할이 서버에 아직 준비되지 않았습니다. 백엔드를 최신 버전으로 배포한 뒤 다시 시도해주세요.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '불러오기에 실패했습니다.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleAuditor(id: string, granted: boolean) {
    setSavingIds((prev) => new Set(prev).add(id));
    setNotice(null);
    try {
      const res = await apiFetch<{ note?: string }>('/users/auditors', {
        method: 'POST',
        body: JSON.stringify({ userId: id, granted }),
      });
      setUsers((prev) => (prev ? prev.map((u) => (u.id === id ? { ...u, isAuditor: granted } : u)) : prev));
      if (res.note) setNotice(res.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장에 실패했습니다.');
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users ?? []).filter(
      (u) => !q || u.name.toLowerCase().includes(q) || u.employeeNo.toLowerCase().includes(q) || u.department.name.toLowerCase().includes(q)
    );
  }, [users, search]);

  const currentAuditors = (users ?? []).filter((u) => u.isAuditor);

  return (
    <div className="admin-shell">
      <AdminHeader title="감사인 권한 관리" />
      <p className="admin-page-subtitle">
        재택(원격) 근무 등록 시 캡처되는 GPS 좌표는 일반 관리자에게도 보이지 않습니다. 여기서 개별로 지정한
        계정만 "재택 위치 감사" 화면에서 열람할 수 있습니다. 권한을 새로 부여받은 사람은 다시 로그인해야
        적용됩니다.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-inline-orange">{notice}</div>}

      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-label">현재 감사인</div>
          <div className="stat-value">{currentAuditors.length}<small>명</small></div>
        </div>
      </div>

      {currentAuditors.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>🛡️ 현재 감사인 목록</h2>
          <p style={{ margin: 0, color: 'var(--dsti-text-muted, #868e96)', fontSize: 13 }}>
            {currentAuditors.map((u) => `${u.name}(${u.department.name})`).join(', ')}
          </p>
        </div>
      )}

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

      {!users && !error && <div className="board-empty">불러오는 중...</div>}

      {users && (
        <div className="card">
          <div className="table-scroll">
            <table className="att-table">
              <thead>
                <tr>
                  <th>감사인 권한</th>
                  <th>이름</th>
                  <th>사번</th>
                  <th>부서</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => {
                  const saving = savingIds.has(u.id);
                  return (
                    <tr key={u.id}>
                      <td>
                        <input
                          type="checkbox"
                          style={{ width: 'auto', margin: 0 }}
                          checked={u.isAuditor}
                          disabled={saving}
                          onChange={(e) => toggleAuditor(u.id, e.target.checked)}
                        />
                      </td>
                      <td>{u.name}</td>
                      <td className="num">{u.employeeNo}</td>
                      <td>{u.department.name}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
