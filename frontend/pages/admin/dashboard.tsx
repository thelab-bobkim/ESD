import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

/** 6자리 hex 색상에 알파를 입혀 옅은 배경톤을 만든다(아이콘 배지 배경용). */
function softBg(hex: string, alphaHex = '20'): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alphaHex}` : hex;
}

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
  'BUSINESS_TRIP', 'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE',
];

// "근무중"으로 집계할 상태 — 요약 통계의 근무중 비율 계산에 사용
const WORKING_STATUSES = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING', 'NIGHT_WORK', 'BUSINESS_TRIP']);
const OFF_STATUSES = new Set(['ALT_DAY_OFF', 'ON_LEAVE']);

const REFRESH_INTERVAL_MS = 15000; // 15초마다 자동 갱신 (실시간에 가까운 폴링)

// 위치대조를 실제로 시도하는 상태만 — 백엔드 LOCATION_CHECK_STATUSES(고객사미팅/작업) +
// HQ_WORKING(본사 위치 자체 확인, attendance.routes.ts 참고)과 동일하게 맞춘다. 나머지 상태
// (재택/출장/이동중 등)는 애초에 위치를 확인하지 않으므로 배지 자체를 안 보여준다.
const LOCATION_CHECK_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK']);

// "한눈에 보는 동선"용 대분류 — 9개 세부상태를 4개 그룹으로 묶어서 즉시 파악되게 한다.
const MACRO_GROUPS: { key: string; label: string; icon: string; color: string; statuses: string[] }[] = [
  { key: 'ONSITE', label: '사내', icon: '🏢', color: '#2f9e44', statuses: ['HQ_WORKING'] },
  { key: 'FIELD', label: '외부업무', icon: '🚗', color: '#1c7ed6', statuses: ['RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING', 'BUSINESS_TRIP'] },
  { key: 'REMOTE', label: '재택', icon: '🏠', color: '#6741d9', statuses: ['REMOTE'] },
  { key: 'OFF', label: '휴무·야간', icon: '🏖️', color: '#868e96', statuses: ['NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE'] },
  { key: 'CLOCKED_OUT', label: '퇴근완료', icon: '🏁', color: '#94a3b8', statuses: [] },
];

interface EmployeeRow {
  userId: string; name: string; department: string; client: string | null; workType: string;
  status: string | null; statusChangedAt: string | null; statusSource: string | null; statusNote: string | null; lastConfirmedAt: string | null;
  // 세부내용(statusNote)을 아직 안 채운 채로 등록된 경우에도, effort_logs에 남아있는 고객사명이
  // 있으면 여기 담겨온다(2026-09-04 — "고객사 정보 없이 등록된 사람" 문의 대응. dashboard.routes.ts 참고).
  effortClientName: string | null;
  locationMatch: boolean | null; locationDistanceMeters: number | null; locationCaptureStatus: string | null;
  locationConsentGiven: boolean; privacyConsentGiven: boolean;
  clockedOut: boolean; clockOutAt: string | null;
}
interface CompanyBoard { summary: Record<string, number>; employees: EmployeeRow[]; }

// 위치대조를 시도하는 상태(LOCATION_CHECK_STATUSES)에서만 의미가 있는 배지 — 셋 중 하나로 갈린다:
// (1) 애초에 개인정보/위치 동의를 안 한 직원 → "개인정보 활용 미동의"(동의를 해야 위치대조 자체가
//     시작된다는 걸 알려서 참여를 유도), (2) 동의는 했지만 그 순간 위치가 안 잡혔거나 대조 결과가
//     아직 없는 경우 → "위치 미확인"(등록된 고객사와 멀리 떨어져 있다는 뜻이 절대 아님 — 그냥 결과가
//     없다는 뜻), (3) 실제로 위치가 확인/불일치까지 된 경우 → 기존 그대로.
function locationBadge(e: EmployeeRow): { text: string; color: string } | null {
  if (!e.locationConsentGiven || !e.privacyConsentGiven) {
    return { text: '🚫 개인정보 활용 미동의', color: '#868e96' };
  }
  if (e.locationMatch === true) return { text: '📍 위치 확인됨', color: '#2f9e44' };
  if (e.locationMatch === false) return { text: `📍 위치 불일치 (약 ${e.locationDistanceMeters}m)`, color: '#e03131' };
  return { text: '⚠ 위치 미확인', color: '#f08c00' };
}

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
  const [pendingApprovalCount, setPendingApprovalCount] = useState<number | null>(null);
  // 출퇴근 알림(푸시) 미설정 직원 현황(2026-09-03 추가) — 알림이 옵트인이라 실제로 몇 명이나
  // 켜뒀는지 볼 방법이 없었던 문제를 해결하기 위해, HR이 직접 챙길 수 있게 목록으로 보여준다.
  const [pushStatus, setPushStatus] = useState<{ userId: string; name: string; department: string; subscribed: boolean }[] | null>(null);
  const [showPushList, setShowPushList] = useState(false);

  // TSB-Ver2.1: 전사 상황판을 다크 관제형 테마로 바꾸면서, 페이지 바깥(뷰포트 좌우 여백)까지
  // 어둡게 보이도록 body에도 클래스를 붙인다(다른 5개 관리자 화면엔 영향 없음 — 언마운트되면 제거).
  useEffect(() => {
    document.body.classList.add('tsb-dark-body');
    return () => document.body.classList.remove('tsb-dark-body');
  }, []);

  useEffect(() => {
    apiFetch<unknown[]>('/approval/requests?status=PENDING')
      .then((rows) => setPendingApprovalCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => setPendingApprovalCount(null));
  }, [board]);

  useEffect(() => {
    apiFetch<{ userId: string; name: string; department: string; subscribed: boolean }[]>('/push/admin/status')
      .then(setPushStatus)
      .catch(() => setPushStatus(null));
  }, [board]);

  const unsubscribedEmployees = useMemo(
    () => (pushStatus ?? []).filter((p) => !p.subscribed).sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [pushStatus]
  );

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
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ko'));
  }, [board]);

  const filteredEmployees = useMemo(() => {
    let list = board?.employees ?? [];
    if (deptFilter !== 'ALL') list = list.filter((e) => e.department === deptFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    // 2026-09-02: 이름 표시 순서를 전 화면에서 통일 — 가나다순으로 정렬한다.
    // (이 목록을 원본으로 삼는 상태별 보드/확인 필요 카드 등도 순서를 그대로 물려받는다.)
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [board, deptFilter, search]);

  const grouped = useMemo(() => {
    const map: Record<string, EmployeeRow[]> = { CLOCKED_OUT: [], UNKNOWN: [] };
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

  // 위치대조를 시도하는 상태(LOCATION_CHECK_STATUSES)에서 실제로 등록을 마친(퇴근 전) 인원만
  // 대상으로, 위치 확인됨/불일치/미확인/미동의 4가지로 나눠 집계한다 — 상단 지표 카드용.
  const locationStats = useMemo(() => {
    let matched = 0, mismatched = 0, unconfirmed = 0, noConsent = 0;
    for (const e of filteredEmployees) {
      if (e.clockedOut) continue;
      if (!e.status || !LOCATION_CHECK_STATUSES.has(e.status)) continue;
      if (!e.locationConsentGiven || !e.privacyConsentGiven) { noConsent += 1; continue; }
      if (e.locationMatch === true) matched += 1;
      else if (e.locationMatch === false) mismatched += 1;
      else unconfirmed += 1;
    }
    return { matched, mismatched, unconfirmed, noConsent, total: matched + mismatched + unconfirmed + noConsent };
  }, [filteredEmployees]);

  // "지금 바로 확인이 필요한 직원" — 위치가 실제로 확인된(matched) 경우를 제외한 나머지.
  // 관리자가 예외 상황부터 먼저 볼 수 있게 상단에 강조 노출한다(2026-09-03 요청).
  const flaggedEmployees = useMemo(() => {
    return filteredEmployees.filter((e) => {
      if (e.clockedOut) return false;
      if (!e.status || !LOCATION_CHECK_STATUSES.has(e.status)) return false;
      if (!e.locationConsentGiven || !e.privacyConsentGiven) return true;
      return e.locationMatch !== true;
    });
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

  const [syncing, setSyncing] = useState<'employees' | null>(null);
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

  // 2026-09-01: "다우오피스 근태 동기화" 버튼은 제거했다 — 다우오피스가 퇴근시각을 안 줘서
  // 매달 돌릴 때마다 미해결(퇴근 없음) 기록이 새로 쌓이는 원인이었다. 이제 출퇴근은 앱에서
  // 직원이 직접 누른 것만 인정한다. 조직도(직원) 동기화 버튼은 그대로 유지.

  const [expandedColumns, setExpandedColumns] = useState<Record<string, boolean>>({});
  function toggleColumn(code: string) {
    setExpandedColumns((prev) => ({ ...prev, [code]: !prev[code] }));
  }

  // "한눈에 보는 동선" 타일(사내/외부업무/재택/휴무·야간/퇴근완료)을 눌렀을 때, 그 타일에 속한
  // 세부상태 컬럼들을 아래 board에서 펼치고 첫 번째 컬럼으로 스크롤해서 보여준다.
  // (기존에는 타일에 hover 스타일만 있고 실제 클릭 동작이 연결돼 있지 않았다.)
  function focusMacroGroup(g: (typeof MACRO_GROUPS)[number]) {
    const codes = g.key === 'CLOCKED_OUT' ? ['CLOCKED_OUT'] : g.statuses;
    if (codes.length === 0) return;
    setExpandedColumns((prev) => {
      const next = { ...prev };
      for (const c of codes) next[c] = true;
      return next;
    });
    requestAnimationFrame(() => {
      document.getElementById(`board-col-${codes[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  return (
    <div className="admin-shell tsb-dark">
      <AdminHeader title="전사 상황판" dark />
      <p className="admin-page-subtitle">지금 누가 어디서 뭘 하고 있는지 한눈에 확인하세요.</p>
      {error && <div className="error">{error}</div>}

      <div className="cc-stat-row">
        <div className="cc-stat-card">
          <div className="cc-stat-label">전체 인원</div>
          <div className="cc-stat-value">{stats.total}<small>명 · {departments.length}개 부서</small></div>
          <div className="cc-stat-foot">근무중 {stats.working} · 휴무·휴가 {stats.off} · 퇴근완료 {stats.clockedOut}</div>
        </div>
        <div className="cc-stat-card">
          <div className="cc-stat-label">근무중</div>
          <div className="cc-stat-value" style={{ color: '#22c55e' }}>{stats.working}<small>명 · {stats.workingRate}%</small></div>
          <div className="stat-bar" style={{ height: 6, borderRadius: 4, background: '#1c2440', marginTop: 10, overflow: 'hidden' }}>
            <div style={{ width: `${stats.workingRate}%`, height: '100%', background: '#22c55e', borderRadius: 4 }} />
          </div>
          <div className="cc-stat-foot">상태 미확인 {stats.unknown}명</div>
        </div>
        <div className="cc-stat-card">
          <div className="cc-stat-label">위치 확인 현황</div>
          <div className="cc-loc-mini">
            <div><span className="n" style={{ color: '#22c55e' }}>{locationStats.matched}</span><span className="l">확인됨</span></div>
            <div><span className="n" style={{ color: '#ef4444' }}>{locationStats.mismatched}</span><span className="l">불일치</span></div>
            <div><span className="n" style={{ color: '#f59e0b' }}>{locationStats.unconfirmed}</span><span className="l">미확인</span></div>
            <div><span className="n" style={{ color: '#94a3b8' }}>{locationStats.noConsent}</span><span className="l">미동의</span></div>
          </div>
          <div className="cc-stat-foot">위치대조 대상 {locationStats.total}명 중</div>
        </div>
        <div className="cc-stat-card" style={{ borderColor: pendingApprovalCount ? '#3a2340' : undefined }}>
          <div className="cc-stat-label">승인 대기</div>
          <div className="cc-stat-value" style={{ color: pendingApprovalCount ? '#ef4444' : undefined }}>
            {pendingApprovalCount ?? '-'}<small>건</small>
          </div>
          <button
            className="secondary"
            style={{ marginTop: 10, width: '100%' }}
            onClick={() => router.push('/admin/approvals')}
          >
            승인함 바로가기 →
          </button>
        </div>
        <div className="cc-stat-card" style={{ borderColor: unsubscribedEmployees.length ? '#3a2340' : undefined }}>
          <div className="cc-stat-label">🔕 알림 미설정</div>
          <div className="cc-stat-value" style={{ color: unsubscribedEmployees.length ? '#f59e0b' : undefined }}>
            {pushStatus ? unsubscribedEmployees.length : '-'}<small>{pushStatus ? `명 / ${pushStatus.length}명 중` : ''}</small>
          </div>
          <button
            className="secondary"
            style={{ marginTop: 10, width: '100%' }}
            disabled={!pushStatus || unsubscribedEmployees.length === 0}
            onClick={() => setShowPushList((v) => !v)}
          >
            {showPushList ? '목록 접기 ▴' : '명단 보기 ▾'}
          </button>
        </div>
      </div>

      {showPushList && unsubscribedEmployees.length > 0 && (
        <>
          <div className="cc-section-title">🔕 출퇴근 알림 미설정 직원 <span className="cnt">{unsubscribedEmployees.length}</span></div>
          <div className="cc-alert-grid">
            {unsubscribedEmployees.map((p) => (
              <div className="cc-alert-card" key={p.userId} style={{ '--cc-accent': '#f59e0b' } as CSSProperties}>
                <div className="cc-alert-head">
                  <div className="cc-alert-name">
                    <div className="cc-avatar">{p.name.slice(-2)}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="nm">{p.name}</div>
                      <div className="dept">{p.department}</div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="toolbar">
        <button style={{ width: 'auto' }} disabled={syncing !== null} onClick={runSyncEmployees}>
          {syncing === 'employees' ? '직원 동기화 중...' : '👤 다우오피스 직원 동기화'}
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

      {flaggedEmployees.length > 0 && (
        <>
          <div className="cc-section-title">⚠️ 지금 확인이 필요한 직원 <span className="cnt">{flaggedEmployees.length}</span></div>
          <div className="cc-alert-grid">
            {flaggedEmployees.map((e) => {
              const badge = locationBadge(e);
              const noConsent = !e.locationConsentGiven || !e.privacyConsentGiven;
              const accent = noConsent ? '#94a3b8' : e.locationMatch === false ? '#ef4444' : '#f59e0b';
              const flagClass = noConsent ? 'gray' : e.locationMatch === false ? 'red' : '';
              const meta = e.status ? STATUS_META[e.status] : null;
              return (
                <div className="cc-alert-card" key={e.userId} style={{ '--cc-accent': accent } as CSSProperties}>
                  <div className="cc-alert-head">
                    <div className="cc-alert-name">
                      <div className="cc-avatar">{e.name.slice(-2)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="nm">
                          {e.name}
                          {e.statusSource === 'SYSTEM' && <span style={{ marginLeft: 6, fontSize: 10, color: '#6b7594', fontWeight: 400 }}>(자동추정)</span>}
                        </div>
                        <div className="dept">{e.department}{meta ? ` · ${meta.icon} ${meta.label}` : ''}</div>
                      </div>
                    </div>
                    {badge && <span className={`cc-alert-flag${flagClass ? ` ${flagClass}` : ''}`}>{badge.text.replace(/^\S+\s/, '')}</span>}
                  </div>
                  {e.statusNote ? (
                    <div className="cc-alert-note">“{e.statusNote}”</div>
                  ) : e.effortClientName ? (
                    <div className="cc-alert-note" style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                      고객사: {e.effortClientName} (세부내용 아직 미입력 — 본인이 앱에서 마저 입력해야 위치확인도 완료돼요)
                    </div>
                  ) : (
                    e.status && LOCATION_CHECK_STATUSES.has(e.status) && (
                      <div className="cc-alert-note" style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                        등록만 되고 세부내용 미입력 상태예요 — 본인이 앱에서 마저 입력해야 위치확인도 완료돼요
                      </div>
                    )
                  )}
                  <div className="cc-stat-foot" style={{ marginTop: 8 }}>{timeAgo(e.statusChangedAt)} 등록</div>
                </div>
              );
            })}
          </div>
        </>
      )}

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
              <div
                className="macro-tile"
                key={g.key}
                role="button"
                tabIndex={0}
                onClick={() => focusMacroGroup(g)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') focusMacroGroup(g);
                }}
                style={{ '--tile-color': g.color, '--tile-color-soft': softBg(g.color) } as CSSProperties}
              >
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
          .map((code) => {
            const meta = STATUS_META[code];
            const employees = grouped[code];
            const isExpanded = expandedColumns[code] ?? (employees.length > 0 && employees.length <= 5);
            return (
              <div className="board-column" id={`board-col-${code}`} key={code} style={{ borderTopColor: meta.color }}>
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
                    <div className="chip-row">
                      <div className="chip-avatar" style={{ background: meta.color }}>{e.name.slice(-2)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="name">
                          {e.name}
                          {e.statusSource === 'SYSTEM' && (
                            <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--dsti-text-faint)', fontWeight: 400 }}>(자동추정)</span>
                          )}
                        </div>
                        <div className="meta">
                          {e.department}
                          {code === 'RESIDENT_ONSITE' && e.client ? ` · ${e.client}` : ''}
                        </div>
                      </div>
                    </div>
                    {code !== 'CLOCKED_OUT' && e.statusNote && <div className="meta" style={{ color: 'var(--dsti-text)', fontStyle: 'italic' }}>“{e.statusNote}”</div>}
                    {code === 'CLOCKED_OUT' && e.status && STATUS_META[e.status] && (
                      <div className="meta">마지막 상태: {STATUS_META[e.status].icon} {STATUS_META[e.status].label}</div>
                    )}
                    {e.status && LOCATION_CHECK_STATUSES.has(e.status) && (() => {
                      const badge = locationBadge(e);
                      return badge && (
                        <div className="meta" style={{ color: badge.color, fontWeight: 600 }} title={e.locationCaptureStatus ?? undefined}>
                          {badge.text}
                        </div>
                      );
                    })()}
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
