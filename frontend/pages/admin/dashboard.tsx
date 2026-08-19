import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';

// 상태별 표시 정보(라벨/아이콘/색상) — "지금 이 사람이 어디서 뭘 하고 있는지"를
// 위치정보 없이도 직관적으로 보여주기 위한 매핑이다. 실제 좌표는 수집하지 않는다(core_principles).
const STATUS_META: Record<string, { label: string; icon: string; color: string }> = {
  HQ_WORKING: { label: '본사근무', icon: '🏢', color: '#2f9e44' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬', color: '#2f9e44' },
  OFFSITE: { label: '외근', icon: '🚗', color: '#1c7ed6' },
  CLIENT_MEETING: { label: '고객사 미팅', icon: '🤝', color: '#1c7ed6' },
  CLIENT_WORK: { label: '고객사 작업', icon: '🛠️', color: '#1c7ed6' },
  MOVING: { label: '이동중', icon: '🚙', color: '#1c7ed6' },
  MEETING: { label: '회의중', icon: '👥', color: '#1c7ed6' },
  REMOTE: { label: '재택(집)', icon: '🏠', color: '#6741d9' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙', color: '#f08c00' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
  UNKNOWN: { label: '상태 미확인', icon: '❔', color: '#e03131' },
};

const STATUS_ORDER = [
  'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING',
  'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'UNKNOWN',
];

// "근무중"으로 집계할 상태 — 요약 통계의 근무중 비율 계산에 사용
const WORKING_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING', 'NIGHT_WORK']);
const OFF_STATUSES = new Set(['ALT_DAY_OFF', 'ON_LEAVE']);

const ALERT_LABELS: Record<string, string> = {
  NO_CLOCK_IN: '미출근', LONG_WORKING: '장시간근무', NIGHT_WORK_NOT_CONVERTED: '야간근무 후 미전환', STATUS_NOT_CONFIRMED: '상태 미확인',
};
const SEVERITY_COLORS: Record<string, string> = { INFO: '#868e96', WARNING: '#f08c00', CRITICAL: '#e03131' };

const REFRESH_INTERVAL_MS = 15000; // 15초마다 자동 갱신 (실시간에 가까운 폴링)
const DEPT_BAR_LIMIT = 10; // 부서별 막대그래프에 표시할 최대 부서 수(인원 많은 순)

interface EmployeeRow {
  userId: string; name: string; department: string; client: string | null; workType: string;
  status: string | null; statusChangedAt: string | null; statusSource: string | null; statusNote: string | null; lastConfirmedAt: string | null;
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
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const [b, a] = await Promise.all([
        apiFetch<CompanyBoard>('/dashboard/company'),
        apiFetch<AlertRow[]>('/alerts'),
      ]);
      setBoard(b);
      setAlerts(a);
      setLastUpdated(new Date());
      setError(null);
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 1500);
    } catch (err) {
      if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
    } finally {
      setRefreshing(false);
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

  // 요약 통계: 전체/근무중/휴가·휴무/미확인 + 근무중 비율
  const stats = useMemo(() => {
    const total = filteredEmployees.length;
    let working = 0;
    let off = 0;
    let unknown = 0;
    for (const e of filteredEmployees) {
      if (e.status && WORKING_STATUSES.has(e.status)) working += 1;
      else if (e.status && OFF_STATUSES.has(e.status)) off += 1;
      else if (!e.status) unknown += 1;
    }
    const workingRate = total > 0 ? Math.round((working / total) * 100) : 0;
    return { total, working, off, unknown, workingRate };
  }, [filteredEmployees]);

  // 부서별 인원 막대그래프 데이터(인원 많은 순 상위 N개)
  const deptBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of filteredEmployees) {
      counts.set(e.department, (counts.get(e.department) ?? 0) + 1);
    }
    const rows = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
    rows.sort((a, b) => b.count - a.count);
    const max = rows.length > 0 ? rows[0].count : 1;
    return { rows: rows.slice(0, DEPT_BAR_LIMIT), max, totalDepts: rows.length };
  }, [filteredEmployees]);

  const [syncing, setSyncing] = useState<'employees' | 'attendance' | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function runSyncEmployees() {
    setSyncing('employees');
    setSyncMessage(null);
    try {
      const result = await apiFetch<{ synced: number; skippedDeptNodes: number; deactivated: number; errors: string[] }>(
        '/dauoffice/sync/employees',
        { method: 'POST' }
      );
      setSyncMessage(
        `직원 동기화 완료 — 반영 ${result.synced}명, 부서노드 제외 ${result.skippedDeptNodes}명, 퇴사처리 ${result.deactivated}명` +
          (result.errors.length > 0 ? ` (오류 ${result.errors.length}건, 예: ${result.errors[0]})` : '')
      );
      await load();
    } catch (err) {
      setSyncMessage(err instanceof Error ? `직원 동기화 실패: ${err.message}` : '직원 동기화 실패');
    } finally {
      setSyncing(null);
    }
  }

  async function runSyncAttendance() {
    setSyncing('attendance');
    setSyncMessage(null);
    try {
      const now = new Date();
      const result = await apiFetch<{ syncedCount: number; statusInferredCount: number; errors: string[] }>('/dauoffice/sync/attendance', {
        method: 'POST',
        body: JSON.stringify({ year: now.getFullYear(), month: now.getMonth() + 1 }),
      });
      setSyncMessage(
        `근태 동기화 완료 — 반영 ${result.syncedCount}건, 잠정 상태 자동추정 ${result.statusInferredCount}명` +
          (result.errors.length > 0 ? ` (오류 ${result.errors.length}건, 예: ${result.errors[0]})` : '')
      );
      await load();
    } catch (err) {
      setSyncMessage(err instanceof Error ? `근태 동기화 실패: ${err.message}` : '근태 동기화 실패');
    } finally {
      setSyncing(null);
    }
  }

  const [expandedColumns, setExpandedColumns] = useState<Record<string, boolean>>({});
  function toggleColumn(code: string) {
    setExpandedColumns((prev) => ({ ...prev, [code]: !prev[code] }));
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="admin-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>전사 상황판 — 지금 누가 어디서 뭘 하고 있나</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/change-password')}>비밀번호 변경</button>
          <button className="secondary" style={{ width: 'auto' }} onClick={logout}>로그아웃</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <button style={{ width: 'auto' }} disabled={syncing !== null} onClick={runSyncEmployees}>
          {syncing === 'employees' ? '직원 동기화 중...' : '👤 다우오피스 직원 동기화'}
        </button>
        <button style={{ width: 'auto' }} className="secondary" disabled={syncing !== null} onClick={runSyncAttendance}>
          {syncing === 'attendance' ? '근태 동기화 중...' : '🕒 다우오피스 근태 동기화(이번달)'}
        </button>
        {syncMessage && <span className="refresh-info">{syncMessage}</span>}
      </div>

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
        <button onClick={load} disabled={refreshing}>{refreshing ? '새로고침 중...' : '지금 새로고침'}</button>
        <span className="refresh-info">
          마지막 업데이트: {lastUpdated ? lastUpdated.toLocaleTimeString('ko-KR') : '-'}
          {justRefreshed && <span style={{ color: '#2f9e44', marginLeft: 6 }}>✓ 갱신됨</span>}
        </span>
      </div>

      <div className="dashboard-layout">
        {/* ===== 메인 컬럼: 요약통계 + 부서별 인원 + 상태별 칸반보드 ===== */}
        <div>
          <div className="stat-row">
            <div className="stat-card">
              <div className="stat-label">전체 인원</div>
              <div className="stat-value">{stats.total}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">근무중</div>
              <div className="stat-value" style={{ color: '#2f9e44' }}>{stats.working}</div>
              <div className="stat-sub">전체의 {stats.workingRate}%</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">휴가·대체휴무</div>
              <div className="stat-value" style={{ color: '#868e96' }}>{stats.off}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">상태 미확인</div>
              <div className="stat-value" style={{ color: stats.unknown > 0 ? '#e03131' : '#495057' }}>{stats.unknown}</div>
              <div className="stat-sub">아직 로그인/출근 안 함</div>
            </div>
          </div>

          {deptBreakdown.rows.length > 0 && (
            <div className="card">
              <h2>
                부서별 인원 {deptBreakdown.totalDepts > DEPT_BAR_LIMIT ? `(상위 ${DEPT_BAR_LIMIT}개 / 전체 ${deptBreakdown.totalDepts}개 부서)` : ''}
              </h2>
              {deptBreakdown.rows.map((row) => (
                <div className="dept-bar-row" key={row.name}>
                  <div className="dept-bar-label" title={row.name}>{row.name}</div>
                  <div className="dept-bar-track">
                    <div className="dept-bar-fill" style={{ width: `${(row.count / deptBreakdown.max) * 100}%` }} />
                  </div>
                  <div className="dept-bar-count">{row.count}</div>
                </div>
              ))}
            </div>
          )}

          <div className="board">
            {STATUS_ORDER.map((code) => {
              const meta = STATUS_META[code];
              const employees = grouped[code];
              const isExpanded = expandedColumns[code] ?? employees.length <= 5;
              return (
                <div className="board-column" key={code} style={{ borderTopColor: meta.color }}>
                  <div
                    className="board-column-header"
                    style={{ cursor: employees.length > 0 ? 'pointer' : 'default' }}
                    onClick={() => employees.length > 0 && toggleColumn(code)}
                  >
                    <span>
                      {employees.length > 0 && <span style={{ display: 'inline-block', width: 12, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>}
                      {' '}{meta.icon} {meta.label}
                    </span>
                    <span className="count">{employees.length}</span>
                  </div>
                  {employees.length === 0 && <div className="board-empty">해당 없음</div>}
                  {employees.length > 0 && !isExpanded && (
                    <div className="board-empty" style={{ cursor: 'pointer' }} onClick={() => toggleColumn(code)}>
                      {employees.length}명 — 클릭하여 펼치기
                    </div>
                  )}
                  {isExpanded && employees.map((e) => (
                    <div className="employee-chip" key={e.userId}>
                      <div className="name">
                        {e.name}
                        {e.statusSource === 'SYSTEM' && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: '#868e96', fontWeight: 400 }}>(자동추정)</span>
                        )}
                      </div>
                      <div className="meta">
                        {e.department}
                        {code === 'RESIDENT_ONSITE' && e.client ? ` · ${e.client}` : ''}
                      </div>
                      {e.statusNote && <div className="meta" style={{ color: '#1c1f24', fontStyle: 'italic' }}>“{e.statusNote}”</div>}
                      <div className="meta">{timeAgo(e.statusChangedAt)}</div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* ===== 사이드 패널: 예외 알림 (메인 화면을 가리지 않도록 오른쪽 고정) ===== */}
        <div className="dashboard-side">
          <div className="card">
            <h2>예외 알림 {alerts ? `(${alerts.length}건)` : ''}</h2>
            {(!alerts || alerts.length === 0) && <div className="board-empty">예외 알림 없음</div>}
            {alerts && alerts.length > 0 && (
              <div>
                {alerts.map((a, i) => (
                  <div className="alert-item" key={i}>
                    <span className="alert-type">{ALERT_LABELS[a.ruleCode] || a.ruleCode}</span>
                    <span className="severity-tag" style={{ background: SEVERITY_COLORS[a.severity] || '#868e96' }}>{a.severity}</span>
                    <div className="alert-target">{board?.employees.find((e) => e.userId === a.userId)?.name ?? a.userId}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
