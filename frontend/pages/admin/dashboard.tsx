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
  BUSINESS_TRIP: { label: '출장', icon: '✈️', color: '#1c7ed6' },
  REMOTE: { label: '재택(집)', icon: '🏠', color: '#6741d9' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙', color: '#f08c00' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
  UNKNOWN: { label: '상태 미확인', icon: '❔', color: '#e03131' },
  CLOCKED_OUT: { label: '퇴근완료', icon: '🏁', color: '#495057' },
};

const STATUS_ORDER = [
  'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING',
  'BUSINESS_TRIP', 'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'UNKNOWN',
];

// "근무중"으로 집계할 상태 — 요약 통계의 근무중 비율 계산에 사용
const WORKING_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING', 'NIGHT_WORK', 'BUSINESS_TRIP']);
const OFF_STATUSES = new Set(['ALT_DAY_OFF', 'ON_LEAVE']);

const REFRESH_INTERVAL_MS = 15000; // 15초마다 자동 갱신 (실시간에 가까운 폴링)

// "한눈에 보는 동선"용 대분류 — 9개 세부상태를 4개 그룹으로 묶어서 즉시 파악되게 한다.
const MACRO_GROUPS: { key: string; label: string; icon: string; color: string; statuses: string[] }[] = [
  { key: 'ONSITE', label: '사내', icon: '🏢', color: '#2f9e44', statuses: ['HQ_WORKING'] },
  { key: 'FIELD', label: '외부업무', icon: '🚗', color: '#1c7ed6', statuses: ['RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING', 'BUSINESS_TRIP'] },
  { key: 'REMOTE', label: '재택', icon: '🏠', color: '#6741d9', statuses: ['REMOTE'] },
  { key: 'OFF', label: '휴무·야간', icon: '🏖️', color: '#868e96', statuses: ['NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE'] },
  { key: 'CLOCKED_OUT', label: '퇴근완료', icon: '🏁', color: '#495057', statuses: [] },
  { key: 'UNKNOWN', label: '미확인', icon: '❔', color: '#e03131', statuses: ['UNKNOWN'] },
];

interface EmployeeRow {
  userId: string; name: string; department: string; client: string | null; workType: string;
  status: string | null; statusChangedAt: string | null; statusSource: string | null; statusNote: string | null; lastConfirmedAt: string | null;
  locationMatch: boolean | null; locationDistanceMeters: number | null;
  clockedOut: boolean; clockOutAt: string | null;
}
interface CompanyBoard { summary: Record<string, number>; employees: EmployeeRow[]; }

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
      const b = await apiFetch<CompanyBoard>('/dashboard/company');
      setBoard(b);
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
    const map: Record<string, EmployeeRow[]> = { CLOCKED_OUT: [] };
    for (const code of STATUS_ORDER) map[code] = [];
    for (const e of filteredEmployees) {
      if (e.clockedOut) {
        map.CLOCKED_OUT.push(e);
        continue;
      }
      const key = e.status && STATUS_META[e.status] ? e.status : 'UNKNOWN';
      map[key].push(e);
    }
    return map;
  }, [filteredEmployees]);

  // 요약 통계: 전체/근무중/휴가·휴무/미확인 + 근무중 비율 (퇴근한 사람은 근무중에서 제외)
  const stats = useMemo(() => {
    const total = filteredEmployees.length;
    let working = 0;
    let off = 0;
    let unknown = 0;
    let clockedOut = 0;
    for (const e of filteredEmployees) {
      if (e.clockedOut) { clockedOut += 1; continue; }
      if (e.status && WORKING_STATUSES.has(e.status)) working += 1;
      else if (e.status && OFF_STATUSES.has(e.status)) off += 1;
      else if (!e.status) unknown += 1;
    }
    const workingRate = total > 0 ? Math.round((working / total) * 100) : 0;
    return { total, working, off, unknown, clockedOut, workingRate };
  }, [filteredEmployees]);

  // "한눈에 보는 동선" — 9개 세부상태를 대분류로 묶어서 집계
  const macroCounts = useMemo(() => {
    const counts = new Map(MACRO_GROUPS.map((g) => [g.key, 0]));
    counts.set('CLOCKED_OUT', grouped.CLOCKED_OUT?.length ?? 0);
    for (const code of STATUS_ORDER) {
      const n = grouped[code]?.length ?? 0;
      const group = MACRO_GROUPS.find((g) => g.statuses.includes(code));
      if (group) counts.set(group.key, (counts.get(group.key) ?? 0) + n);
    }
    return counts;
  }, [grouped]);

  const donutGradient = useMemo(() => {
    const total = stats.total;
    if (total === 0) return '#e9ecef';
    let acc = 0;
    const parts = MACRO_GROUPS.map((g) => {
      const n = macroCounts.get(g.key) ?? 0;
      const start = (acc / total) * 100;
      acc += n;
      const end = (acc / total) * 100;
      return `${g.color} ${start}% ${end}%`;
    });
    return `conic-gradient(${parts.join(', ')})`;
  }, [macroCounts, stats.total]);

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
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/admin/clients')}>고객사 위치관리</button>
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/admin/calendar')}>캘린더</button>
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/admin/reports')}>출퇴근·근로시간·공수</button>
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

      <div className="macro-section">
        <div className="donut-wrap">
          <div className="donut-chart" style={{ background: donutGradient }}>
            <div className="donut-hole">
              <div className="donut-total">{stats.total}</div>
              <div className="donut-total-label">전체</div>
            </div>
          </div>
        </div>
        <div className="macro-tiles">
          {MACRO_GROUPS.map((g) => {
            const n = macroCounts.get(g.key) ?? 0;
            const pct = stats.total > 0 ? Math.round((n / stats.total) * 100) : 0;
            return (
              <div className="macro-tile" key={g.key} style={{ borderLeftColor: g.color }}>
                <div className="macro-tile-icon">{g.icon}</div>
                <div>
                  <div className="macro-tile-label">{g.label}</div>
                  <div className="macro-tile-value" style={{ color: g.color }}>{n}<span className="macro-tile-pct">명 · {pct}%</span></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="board">
        {['CLOCKED_OUT', ...STATUS_ORDER]
          .filter((code) => (grouped[code]?.length ?? 0) > 0)
          .map((code) => {
            const meta = STATUS_META[code];
            const employees = grouped[code];
            const isExpanded = expandedColumns[code] ?? employees.length <= 5;
            return (
              <div className="board-column" key={code} style={{ borderTopColor: meta.color }}>
                <div
                  className="board-column-header"
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleColumn(code)}
                >
                  <span>
                    <span style={{ display: 'inline-block', width: 12, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
                    {' '}{meta.icon} {meta.label}
                  </span>
                  <span className="count">{employees.length}</span>
                </div>
                {!isExpanded && (
                  <div className="board-empty" style={{ cursor: 'pointer' }} onClick={() => toggleColumn(code)}>
                    {employees.length}명 — 클릭하여 펼치기
                  </div>
                )}
                {isExpanded && employees.map((e) => (
                  <div className="employee-chip" key={e.userId}>
                    <div className="chip-row">
                      <div className="chip-avatar" style={{ background: meta.color }}>{e.name.slice(-2)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
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
                      </div>
                    </div>
                    {code !== 'CLOCKED_OUT' && e.statusNote && <div className="meta" style={{ color: '#1c1f24', fontStyle: 'italic' }}>“{e.statusNote}”</div>}
                    {code === 'CLOCKED_OUT' && e.status && STATUS_META[e.status] && (
                      <div className="meta">마지막 상태: {STATUS_META[e.status].icon} {STATUS_META[e.status].label}</div>
                    )}
                    {e.locationMatch !== null && (
                      <div className="meta" style={{ color: e.locationMatch ? '#2f9e44' : '#e03131', fontWeight: 600 }}>
                        {e.locationMatch ? '📍 위치 확인됨' : `📍 위치 불일치 (약 ${e.locationDistanceMeters}m)`}
                      </div>
                    )}
                    <div className="meta">{code === 'CLOCKED_OUT' ? `퇴근 ${timeAgo(e.clockOutAt)}` : timeAgo(e.statusChangedAt)}</div>
                  </div>
                ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}
