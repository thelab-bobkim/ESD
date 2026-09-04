import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

interface BoardScopeUser {
  id: string;
  name: string;
  employeeNo: string;
  includedInBoard: boolean;
  lastLoginAt: string | null;
  department: { id: string; name: string };
}
interface PushStatusRow { userId: string; name: string; department: string; subscribed: boolean; }

const INACTIVE_DAYS_WARNING = 7; // 이 일수 이상 로그인이 없으면 "미접속 주의"로 표시

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function formatLastLogin(iso: string | null): string {
  if (!iso) return '로그인 이력 없음';
  const days = daysSince(iso);
  if (days <= 0) return `오늘 ${new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return '어제';
  if (days < 30) return `${days}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

/**
 * 상황판/출퇴근 현황 표시 대상 관리 화면(2026-09-04 추가).
 * 회사가 다우오피스 전체 조직도가 아니라 특정 부서·인원만 시범적으로 상황판에 보이길 원해서,
 * 부서 단위로 묶어 전체 포함/제외를 고르거나 개별 직원을 켜고 끌 수 있게 했다. 같은 화면에서
 * 로그인 이력·알림 설정 여부도 함께 보여줘서 "이 사람이 앱을 아예 안 쓰고 있다"도 바로 드러난다.
 */
export default function AdminBoardScopePage() {
  const [users, setUsers] = useState<BoardScopeUser[] | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  async function load() {
    setError(null);
    try {
      const [u, push] = await Promise.all([
        apiFetch<BoardScopeUser[]>('/users/board-scope'),
        apiFetch<PushStatusRow[]>('/push/admin/status').catch(() => [] as PushStatusRow[]),
      ]);
      setUsers(u);
      setPushSubscribed(new Map(push.map((p) => [p.userId, p.subscribed])));
    } catch (err) {
      setError(err instanceof Error ? err.message : '불러오기에 실패했습니다.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleUsers(ids: string[], included: boolean) {
    if (ids.length === 0) return;
    setSavingIds((prev) => new Set([...prev, ...ids]));
    try {
      await apiFetch('/users/board-scope', { method: 'POST', body: JSON.stringify({ userIds: ids, included }) });
      setUsers((prev) => (prev ? prev.map((u) => (ids.includes(u.id) ? { ...u, includedInBoard: included } : u)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장에 실패했습니다.');
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, { deptName: string; rows: BoardScopeUser[] }>();
    for (const u of users ?? []) {
      if (q && !u.name.toLowerCase().includes(q) && !u.employeeNo.toLowerCase().includes(q)) continue;
      const key = u.department.id;
      if (!map.has(key)) map.set(key, { deptName: u.department.name, rows: [] });
      map.get(key)!.rows.push(u);
    }
    return Array.from(map.values()).sort((a, b) => a.deptName.localeCompare(b.deptName, 'ko'));
  }, [users, search]);

  const stats = useMemo(() => {
    const all = users ?? [];
    const included = all.filter((u) => u.includedInBoard);
    const neverLoggedIn = included.filter((u) => !u.lastLoginAt);
    const inactive = included.filter((u) => u.lastLoginAt && daysSince(u.lastLoginAt) >= INACTIVE_DAYS_WARNING);
    return { total: all.length, includedCount: included.length, neverLoggedIn: neverLoggedIn.length, inactive: inactive.length };
  }, [users]);

  return (
    <div className="admin-shell">
      <AdminHeader title="표시 대상 관리" />
      <p className="admin-page-subtitle">전사 상황판·출퇴근 현황에 표시할 부서·직원을 선택하고, 로그인·알림 설정 현황을 확인하세요.</p>
      {error && <div className="error">{error}</div>}

      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-label">전체 재직 인원</div>
          <div className="stat-value">{stats.total}<small>명</small></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">표시 대상으로 포함됨</div>
          <div className="stat-value" style={{ color: '#2f9e44' }}>{stats.includedCount}<small>명</small></div>
        </div>
        <div className="stat-card" style={{ borderColor: stats.neverLoggedIn ? '#f4d0d0' : undefined }}>
          <div className="stat-label">로그인 이력 없음</div>
          <div className="stat-value" style={{ color: stats.neverLoggedIn ? '#e03131' : undefined }}>{stats.neverLoggedIn}<small>명</small></div>
        </div>
        <div className="stat-card" style={{ borderColor: stats.inactive ? '#ffe0b2' : undefined }}>
          <div className="stat-label">{INACTIVE_DAYS_WARNING}일 이상 미접속</div>
          <div className="stat-value" style={{ color: stats.inactive ? '#f08c00' : undefined }}>{stats.inactive}<small>명</small></div>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="text"
          placeholder="이름 또는 사번 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="spacer" />
        <button onClick={load}>새로고침</button>
      </div>

      {!users && !error && <div className="board-empty">불러오는 중...</div>}

      {grouped.map(({ deptName, rows }) => {
        const includedCount = rows.filter((r) => r.includedInBoard).length;
        const deptIds = rows.map((r) => r.id);
        return (
          <div className="card" key={deptName}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>🏷️ {deptName} <span style={{ fontWeight: 400, color: 'var(--dsti-text-muted, #868e96)', fontSize: 13 }}>{includedCount}/{rows.length}명 포함</span></h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ width: 'auto', margin: 0 }} onClick={() => toggleUsers(deptIds, true)}>이 부서 전체 포함</button>
                <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => toggleUsers(deptIds, false)}>이 부서 전체 제외</button>
              </div>
            </div>
            <div className="table-scroll">
              <table className="att-table">
                <thead>
                  <tr>
                    <th>표시</th>
                    <th>이름</th>
                    <th>사번</th>
                    <th>최근 로그인</th>
                    <th>알림</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const saving = savingIds.has(u.id);
                    const inactiveWarn = u.includedInBoard && u.lastLoginAt && daysSince(u.lastLoginAt) >= INACTIVE_DAYS_WARNING;
                    const neverLoggedIn = u.includedInBoard && !u.lastLoginAt;
                    return (
                      <tr key={u.id}>
                        <td>
                          <input
                            type="checkbox"
                            style={{ width: 'auto', margin: 0 }}
                            checked={u.includedInBoard}
                            disabled={saving}
                            onChange={(e) => toggleUsers([u.id], e.target.checked)}
                          />
                        </td>
                        <td>{u.name}</td>
                        <td className="num">{u.employeeNo}</td>
                        <td>
                          {formatLastLogin(u.lastLoginAt)}
                          {neverLoggedIn && <span className="att-pill att-pill-danger" style={{ marginLeft: 6 }}>미사용</span>}
                          {!neverLoggedIn && inactiveWarn && <span className="att-pill att-pill-warn" style={{ marginLeft: 6 }}>미접속 주의</span>}
                        </td>
                        <td>
                          {pushSubscribed.get(u.id) ? (
                            <span className="att-pill att-pill-ok">🔔 켜짐</span>
                          ) : (
                            <span className="att-pill att-pill-neutral">🔕 꺼짐</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
