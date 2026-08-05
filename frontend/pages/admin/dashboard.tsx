import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';

// 상태별 표시 정보(라벨/아이콘/색상) — "지금 이 사람이 어디서 뭘 하고 있는지"를
// 위치정보 없이도 직관적으로 보여주기 위한 매핑이다. 실제 좌표는 수집하지 않는다(core_principles).
const STATUS_META: Record<string, { label: string; icon: string; color: string }> = {
  HQ_WORKING: { label: '본사근무', icon: '🏢', color: '#2f9e44' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬', color: '#2f9e44' },
  OFFSITE: { label: '외근', icon: '🚗', color: '#1c7ed6' },
  MOVING: { label: '이동중', icon: '🚙', color: '#1c7ed6' },
  MEETING: { label: '회의중', icon: '👥', color: '#1c7ed6' },
  REMOTE: { label: '재택(집)', icon: '🏠', color: '#6741d9' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙', color: '#f08c00' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🌴', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
  UNKNOWN: { label: '상태 미확인', icon: '❔', color: '#e03131' },
};

const STATUS_ORDER = [
  'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'MOVING', 'MEETING',
  'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'UNKNOWN',
];

const ALERT_LABELS: Record<string, string> = {
  NO_CLOCK_IN: '미출근', LONG_WORKING: '장시간근무', NIGHT_WORK_NOT_CONVERTED: '야간근무 후 미전환', STATUS_NOT_CONFIRMED: '상태 미확인',
};

const REFRESH_INTERVAL_MS = 15000; // 15초마다 자동 갱신 (실시간에 가까운 폴링)

interface EmployeeRow {
  userId: string; name: string; department: string; client: string | null; workType: string;
  status: string | null; statusChangedAt: string | null; lastConfirmedAt: string | null;
}
interface CompanyBoard { summary: Record<string, number>; employees: EmployeeRow[]; }
interface AlertRow { ruleCode: string; userId: string; relatedId?: string; severity: string; }

function timeAgo(iso: string | null): string {
  if (!iso) return '-';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

export default function AdminDashboard() {
  const router = useRouter();
  const [board, setBoard] = useState<CompanyBoard | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  async function load() {
    try {
      const [b, a] = await Promise.all([
        apiFetch<CompanyBoard>('/dashboard/company'),
        apiFetch<AlertRow[]>('/alerts'),
      ]);
      setBoard(b);
      setAlerts(a);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.message.includes('로그인')) router.push('/login');
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  const departments = useMemo(() => {
    const set = new Set((board?.employees ?? []).map((e) => e.department));
    return Array.from(set).sort();
  }, [board]);

  const filteredEmployees = useMemo(() => {
    let list = board?.employees ?? [];
    if (deptFilter !== 'ALL') list = list.filter((e) => e.department === deptFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    return list;
  }, [board, deptFilter, search]);

  const grouped = useMemo(() => {
    const map: Record<string, EmployeeRow[]> = {};
    for (const code of STATUS_ORDER) map[code] = [];
    for (const e of filteredEmployees) {
      const key = e.status && STATUS_META[e.status] ? e.status : 'UNKNOWN';
      map[key].push(e);
    }
    return map;
  }, [filteredEmployees]);

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="admin-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>전사 상황판 — 지금 누가 어디서 뭘 하고 있나</h1>
        <button className="secondary" style={{ width: 'auto' }} onClick={logout}>로그아웃</button>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
          <option value="ALL">전체 부서</option>
          {departments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="이름 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="spacer" />
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          자동 갱신(15초)
        </label>
        <button onClick={load}>지금 새로고침</button>
        <span className="refresh-info">
          마지막 업데이트: {lastUpdated ? lastUpdated.toLocaleTimeString('ko-KR') : '-'} · 전체 {filteredEmployees.length}명
        </span>
      </div>

      {alerts && alerts.length > 0 && (
        <div className="card">
          <h2>예외 알림 ({alerts.length}건)</h2>
          <table>
            <thead><tr><th>유형</th><th>대상</th><th>심각도</th></tr></thead>
            <tbody>
              {alerts.map((a, i) => (
                <tr key={i}>
                  <td>{ALERT_LABELS[a.ruleCode] || a.ruleCode}</td>
                  <td>{board?.employees.find((e) => e.userId === a.userId)?.name ?? a.userId}</td>
                  <td>{a.severity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="board">
        {STATUS_ORDER.map((code) => {
          const meta = STATUS_META[code];
          const employees = grouped[code];
          return (
            <div className="board-column" key={code} style={{ borderTopColor: meta.color }}>
              <div className="board-column-header">
                <span>{meta.icon} {meta.label}</span>
                <span className="count">{employees.length}</span>
              </div>
              {employees.length === 0 && <div className="board-empty">해당 없음</div>}
              {employees.map((e) => (
                <div className="employee-chip" key={e.userId}>
                  <div className="name">{e.name}</div>
                  <div className="meta">
                    {e.department}
                    {code === 'RESIDENT_ONSITE' && e.client ? ` · ${e.client}` : ''}
                  </div>
                  <div className="meta">{timeAgo(e.statusChangedAt)}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
