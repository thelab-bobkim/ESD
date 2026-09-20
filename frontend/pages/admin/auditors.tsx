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
 * 않고, 여기서 지정한 "딱 한 명"만 완전히 분리된 별도 로그인(/audit-login → /audit)으로 볼 수
 * 있다. 서버가 감사인을 항상 1명으로 강제하므로(users.routes.ts, 새로 지정하면 기존 보유자는
 * 자동 회수), 체크박스를 켜면 다른 사람의 체크는 자동으로 꺼진다 — 그래서 저장 후 매번 전체
 * 목록을 새로고침해서 그 결과를 그대로 보여준다. SYSTEM_ADMIN 전용 화면이다.
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
    setError(null);
    try {
      const res = await apiFetch<{ note?: string }>('/users/auditors', {
        method: 'POST',
        body: JSON.stringify({ userId: id, granted }),
      });
      if (res.note) setNotice(res.note);
      // 감사인은 서버가 항상 1명으로 강제한다 — 이 토글로 다른 사람이 자동으로 회수됐을 수
      // 있으니, 낙관적으로 이 행만 바꾸지 않고 전체를 다시 불러와 실제 결과를 그대로 반영한다.
      await load();
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
        재택(원격) 근무 등록 시 캡처되는 GPS 좌표는 일반 관리자에게도 보이지 않습니다. 여기서 체크한 딱
        한 명만, 완전히 분리된 별도 로그인 화면(/audit-login)에서 아이디·비번과 OTP 인증앱 코드를
        확인해야 열람할 수 있습니다. 다른 사람을 새로 지정하면 기존 감사인의 권한과 OTP 등록은
        자동으로 해제되고, 새로 지정된 사람은 처음 로그인할 때 인증앱을 새로 등록해야 합니다.
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
