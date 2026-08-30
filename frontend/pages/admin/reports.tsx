import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload, clearToken } from '@/lib/api';

const WEEKLY_LIMIT_MINUTES = 52 * 60; // 주52시간제 기준
type Period = 'day' | 'week' | 'month' | 'year';
const PERIOD_LABELS: Record<Period, string> = { day: '일', week: '주', month: '월', year: '년' };
const WORK_TYPE_OPTIONS = ['정기점검', '신규설치', '장애대응', '미팅', '기타'];
const WORK_TYPE_ICONS: Record<string, string> = { 정기점검: '🔧', 신규설치: '🆕', 장애대응: '🚨', 미팅: '🤝', 기타: '📌' };

// 타임라인에 표시할 상태별 아이콘/라벨/색상 (직원화면 STATUS_META와 동일한 코드 목록)
const TIMELINE_STATUS_META: Record<string, { label: string; icon: string; color: string }> = {
  REMOTE: { label: '재택(집)', icon: '🏠', color: '#6741d9' },
  HQ_WORKING: { label: '본사근무', icon: '🏢', color: '#2f9e44' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬', color: '#2f9e44' },
  OFFSITE: { label: '외근', icon: '🚗', color: '#1c7ed6' },
  MOVING: { label: '이동중', icon: '🚙', color: '#1c7ed6' },
  MEETING: { label: '회의중', icon: '👥', color: '#1c7ed6' },
  CLIENT_MEETING: { label: '고객사미팅', icon: '🤝', color: '#1c7ed6' },
  CLIENT_WORK: { label: '고객사작업', icon: '🛠️', color: '#1c7ed6' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙', color: '#f08c00' },
  BUSINESS_TRIP: { label: '출장', icon: '✈️', color: '#1c7ed6' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
};

interface WorktimeRow {
  userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number;
}
interface WorktimeSummary { from: string; to: string; rows: WorktimeRow[]; }

interface AttendanceDetailRow {
  userId: string; employeeNo: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; clockOutLocation: string | null; totalWorkedMinutes: number | null;
}
interface AttendanceDetail { date: string; rows: AttendanceDetailRow[]; }

interface TimelineEntry { status: string; changedAt: string; note: string | null; durationMinutes: number; ongoing: boolean; }
interface DailyTimeline {
  date: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; clockOutLocation: string | null; totalWorkedMinutes: number | null;
  timeline: TimelineEntry[];
}

interface EffortByUser { userId: string; name: string; minutes: number; }
interface EffortProjectRow { projectName: string; clientName: string; totalMinutes: number; workTypes: string[]; byUser: EffortByUser[]; }
interface EffortClientRow {
  clientName: string; totalMinutes: number; projectCount: number; engineerCount: number;
  topEngineerName: string | null; concentrationPct: number; topWorkType: string | null; trendPct: number | null;
  projects: EffortProjectRow[];
}
interface EffortSummary { from: string; to: string; clients: EffortClientRow[]; }

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}
function startOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday;
}

function computeRange(period: Period, anchor: Date): { from: Date; to: Date; label: string } {
  if (period === 'day') return { from: anchor, to: anchor, label: fmt(anchor) };
  if (period === 'week') {
    const from = startOfWeek(anchor);
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    return { from, to, label: `${fmt(from)} ~ ${fmt(to)}` };
  }
  if (period === 'month') {
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { from, to, label: `${anchor.getFullYear()}년 ${anchor.getMonth() + 1}월` };
  }
  const from = new Date(anchor.getFullYear(), 0, 1);
  const to = new Date(anchor.getFullYear(), 11, 31);
  return { from, to, label: `${anchor.getFullYear()}년` };
}

function shiftAnchor(period: Period, anchor: Date, dir: 1 | -1): Date {
  const d = new Date(anchor);
  if (period === 'day') d.setDate(d.getDate() + dir);
  else if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else if (period === 'month') d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  return d;
}

// 하루의 경계는 자정이 아니라 새벽 3시(KST) — backend attendance-helpers.ts의 todayDateOnly()와
// 동일한 규칙. "진행중"이 오늘(정상)인지 지난 근무일(미해결 문제)인지 구분하는 데 쓴다.
function todayWorkDateKST(): string {
  const now = new Date();
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  const y = kstShifted.getUTCFullYear();
  const mo = String(kstShifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kstShifted.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function AttendanceRowTr({ r, date, onClick, hideDept }: { r: AttendanceDetailRow; date: string; onClick: () => void; hideDept?: boolean }) {
  const isPastDayUnresolved = !r.clockOutAt && date < todayWorkDateKST();
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onClick}>
      <td>
        <div className="chip-row">
          <div className="chip-avatar" style={{ background: r.clockOutAt ? '#2f9e44' : isPastDayUnresolved ? '#e03131' : '#f08c00' }}>{r.name.slice(-2)}</div>
          {r.name}
          <span style={{ fontSize: 11, color: '#2f6feb', marginLeft: 4 }}>상세보기 ▸</span>
        </div>
      </td>
      {!hideDept && <td>{r.department}</td>}
      <td>{fmtTime(r.clockInAt)}</td>
      <td>
        {r.clockOutAt ? (
          <>
            {fmtTime(r.clockOutAt)}
            {r.clockOutLocation && <div style={{ fontSize: 11, color: '#868e96' }}>📍 {r.clockOutLocation}</div>}
          </>
        ) : isPastDayUnresolved ? (
          <span style={{ color: '#e03131', fontWeight: 600 }}>⚠ 미해결(지난 근무일)</span>
        ) : (
          <span style={{ color: '#f08c00', fontWeight: 600 }}>● 진행중</span>
        )}
      </td>
      <td>{r.totalWorkedMinutes != null ? hoursLabel(r.totalWorkedMinutes) : '-'}</td>
    </tr>
  );
}

export default function AdminReportsPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('day');
  const [anchor, setAnchor] = useState(new Date());
  const [worktime, setWorktime] = useState<WorktimeSummary | null>(null);
  const [attendanceDetail, setAttendanceDetail] = useState<AttendanceDetail | null>(null);
  const [effort, setEffort] = useState<EffortSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [workTypeFilter, setWorkTypeFilter] = useState('ALL');
  // 년/월/일을 직접 선택하는 기간 — 지정하면 위 탭(일/주/월/년)보다 우선한다. 출퇴근·근로시간·공수 전부 공통 적용.
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [timelineTarget, setTimelineTarget] = useState<{ userId: string; date: string } | null>(null);
  const [groupByDept, setGroupByDept] = useState(true);
  const [timeline, setTimeline] = useState<DailyTimeline | null>(null);

  function openTimeline(userId: string, date: string) {
    setTimelineTarget({ userId, date });
    setTimeline(null);
    apiFetch<DailyTimeline>(`/reports/daily-timeline?date=${date}&userId=${userId}`)
      .then(setTimeline)
      .catch((err) => setError(err instanceof Error ? err.message : '타임라인을 불러오지 못했습니다.'));
  }

  const tabRange = useMemo(() => computeRange(period, anchor), [period, anchor]);
  const isCustom = Boolean(customFrom && customTo);
  const effectiveFrom = isCustom ? customFrom : fmt(tabRange.from);
  const effectiveTo = isCustom ? customTo : fmt(tabRange.to);
  const isSingleDay = effectiveFrom === effectiveTo;
  const rangeLabel = isCustom ? `${customFrom} ~ ${customTo}(직접 선택)` : tabRange.label;

  useEffect(() => {
    setError(null);
    if (isSingleDay) {
      setWorktime(null);
      apiFetch<AttendanceDetail>(`/reports/attendance-detail?date=${effectiveFrom}`)
        .then(setAttendanceDetail)
        .catch((err) => {
          if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
          setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
        });
    } else {
      setAttendanceDetail(null);
      apiFetch<WorktimeSummary>(`/reports/worktime-summary?from=${effectiveFrom}&to=${effectiveTo}`)
        .then(setWorktime)
        .catch((err) => setError(err instanceof Error ? err.message : '오류가 발생했습니다.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFrom, effectiveTo, isSingleDay]);

  useEffect(() => {
    apiFetch<EffortSummary>(`/reports/effort-summary?from=${effectiveFrom}&to=${effectiveTo}&workType=${workTypeFilter}`)
      .then(setEffort)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFrom, effectiveTo, workTypeFilter]);

  function toggleProject(key: string) {
    setExpandedProjects((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function selectTab(p: Period) {
    setCustomFrom('');
    setCustomTo('');
    setPeriod(p);
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  // 요약 카드 계산
  const daySummary = useMemo(() => {
    if (!attendanceDetail) return null;
    const total = attendanceDetail.rows.length;
    const inProgress = attendanceDetail.rows.filter((r) => r.clockInAt && !r.clockOutAt).length;
    const done = attendanceDetail.rows.filter((r) => r.clockOutAt).length;
    return { total, inProgress, done };
  }, [attendanceDetail]);

  // 부서별 보기 — 조직도(부서명) 기준으로 묶어서, 부서명은 가나다순 / 부서 안에서는 출근시각순으로 보여준다.
  const attendanceByDept = useMemo(() => {
    if (!attendanceDetail) return null;
    const map = new Map<string, AttendanceDetailRow[]>();
    for (const r of attendanceDetail.rows) {
      const key = r.department || '(부서 미지정)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([department, rows]) => ({
        department,
        rows: [...rows].sort((a, b) => (a.clockInAt ?? '').localeCompare(b.clockInAt ?? '')),
      }));
  }, [attendanceDetail]);

  const periodSummary = useMemo(() => {
    if (!worktime) return null;
    const total = worktime.rows.length;
    const totalMinutes = worktime.rows.reduce((s, r) => s + r.totalMinutes, 0);
    const avgMinutes = total > 0 ? Math.round(totalMinutes / total) : 0;
    const overCount = period === 'week' && !isCustom ? worktime.rows.filter((r) => r.totalMinutes > WEEKLY_LIMIT_MINUTES).length : 0;
    return { total, avgMinutes, overCount };
  }, [worktime, period, isCustom]);

  const effortTotalMinutes = useMemo(() => (effort ? effort.clients.reduce((s, c) => s + c.totalMinutes, 0) : 0), [effort]);

  return (
    <div className="admin-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>📋 출퇴근 · 근로시간 · 공수 리포트</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/admin/dashboard')}>상황판으로</button>
          <button className="secondary" style={{ width: 'auto' }} onClick={logout}>로그아웃</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button key={p} className={period === p && !isCustom ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => selectTab(p)}>
            {PERIOD_LABELS[p]}별
          </button>
        ))}
        <div className="spacer" />
        <button className="secondary" style={{ width: 'auto' }} disabled={isCustom} onClick={() => setAnchor(shiftAnchor(period, anchor, -1))}>‹ 이전</button>
        <span style={{ fontWeight: 700, minWidth: 160, textAlign: 'center' }}>{rangeLabel}</span>
        <button className="secondary" style={{ width: 'auto' }} disabled={isCustom} onClick={() => setAnchor(shiftAnchor(period, anchor, 1))}>다음 ›</button>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => { setCustomFrom(''); setCustomTo(''); setAnchor(new Date()); }}>오늘</button>
      </div>

      {/* 년/월/일을 직접 선택하는 기간 — 출퇴근/근로시간/공수 전체에 공통 적용 */}
      <div className="toolbar">
        <span style={{ fontSize: 13, color: '#495057' }}>직접 기간선택:</span>
        <input type="date" style={{ margin: 0, width: 'auto' }} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
        <span style={{ color: '#868e96' }}>~</span>
        <input type="date" style={{ margin: 0, width: 'auto' }} value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
        {isCustom && (
          <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => { setCustomFrom(''); setCustomTo(''); }}>
            기간선택 해제(탭으로 돌아가기)
          </button>
        )}
      </div>

      {/* 요약 카드 */}
      {isSingleDay && daySummary && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">👥 활동 인원</div>
            <div className="stat-value">{daySummary.total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">🟠 근무중(진행)</div>
            <div className="stat-value" style={{ color: '#f08c00' }}>{daySummary.inProgress}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">✅ 퇴근 완료</div>
            <div className="stat-value" style={{ color: '#2f9e44' }}>{daySummary.done}</div>
          </div>
        </div>
      )}
      {!isSingleDay && periodSummary && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">👥 근무 인원</div>
            <div className="stat-value">{periodSummary.total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">⏱️ 1인 평균</div>
            <div className="stat-value">{hoursLabel(periodSummary.avgMinutes)}</div>
          </div>
          {period === 'week' && !isCustom && (
            <div className="stat-card">
              <div className="stat-label">⚠️ 52시간 초과</div>
              <div className="stat-value" style={{ color: periodSummary.overCount > 0 ? '#e03131' : '#495057' }}>{periodSummary.overCount}명</div>
            </div>
          )}
        </div>
      )}

      {/* 하루 단위: 출퇴근 상세표 */}
      {isSingleDay && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <h2>🕒 출퇴근 현황 — {rangeLabel}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                style={{ width: 'auto', margin: 0 }}
                className={groupByDept ? undefined : 'secondary'}
                onClick={() => setGroupByDept((v) => !v)}
              >
                {groupByDept ? '👥 부서별 보기 중' : '📋 전체 목록 보기 중'}
              </button>
              <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
                CSV 내려받기
              </button>
            </div>
          </div>
          {!attendanceDetail && <div className="board-empty">불러오는 중...</div>}
          {attendanceDetail && attendanceDetail.rows.length === 0 && <div className="board-empty">이 날짜에 출근 기록이 없습니다.</div>}

          {attendanceDetail && attendanceDetail.rows.length > 0 && !groupByDept && (
            <table>
              <thead>
                <tr><th>이름</th><th>부서</th><th>출근</th><th>퇴근</th><th>근무시간</th></tr>
              </thead>
              <tbody>
                {attendanceDetail.rows.map((r) => (
                  <AttendanceRowTr key={r.userId} r={r} date={attendanceDetail.date} onClick={() => openTimeline(r.userId, attendanceDetail.date)} />
                ))}
              </tbody>
            </table>
          )}

          {attendanceByDept && attendanceByDept.length > 0 && groupByDept && attendanceByDept.map(({ department, rows }) => (
            <div key={department} style={{ marginBottom: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#2f6feb', margin: '10px 0 4px' }}>
                🏷️ {department} <span style={{ color: '#868e96', fontWeight: 400 }}>({rows.length}명)</span>
              </div>
              <table>
                <thead>
                  <tr><th>이름</th><th>출근</th><th>퇴근</th><th>근무시간</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <AttendanceRowTr key={r.userId} r={r} date={attendanceDetail!.date} onClick={() => openTimeline(r.userId, attendanceDetail!.date)} hideDept />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {/* 여러 날: 누적 근무시간 표 */}
      {!isSingleDay && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>📊 근무시간 누계 (주52시간제 기준) — {rangeLabel}</h2>
            <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
              CSV 내려받기
            </button>
          </div>
          {!worktime && <div className="board-empty">불러오는 중...</div>}
          {worktime && worktime.rows.length === 0 && <div className="board-empty">이 기간에 확정된 근무기록이 없습니다.</div>}
          {worktime && worktime.rows.length > 0 && (
            <table>
              <thead>
                <tr><th>이름</th><th>부서</th><th>누계</th><th>근무일수</th></tr>
              </thead>
              <tbody>
                {worktime.rows.map((r) => {
                  const over = period === 'week' && !isCustom && r.totalMinutes > WEEKLY_LIMIT_MINUTES;
                  return (
                    <tr key={r.userId} style={{ cursor: 'pointer' }} onClick={() => openTimeline(r.userId, fmt(new Date()))}>
                      <td>
                        <div className="chip-row">
                          <div className="chip-avatar" style={{ background: over ? '#e03131' : '#2f6feb' }}>{r.name.slice(-2)}</div>
                          {r.name}
                          <span style={{ fontSize: 11, color: '#2f6feb', marginLeft: 4 }}>오늘 상세 ▸</span>
                        </div>
                      </td>
                      <td>{r.department}</td>
                      <td style={{ color: over ? '#e03131' : undefined, fontWeight: over ? 700 : undefined }}>
                        {hoursLabel(r.totalMinutes)}{over ? ' ⚠ 52시간 초과' : ''}
                      </td>
                      <td>{r.days}일</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 고객사별 공수 현황 — 관리 판단 기준(총 투입시간/편중도/증감/주요유형) 중심으로 재구성 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2>🛠️ 고객사별 공수(工數) 현황 — {rangeLabel}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="field-select" style={{ margin: 0, width: 'auto' }} value={workTypeFilter} onChange={(e) => setWorkTypeFilter(e.target.value)}>
              <option value="ALL">전체 작업유형</option>
              {WORK_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{WORK_TYPE_ICONS[t]} {t}</option>
              ))}
            </select>
            <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/effort-export', 'effort-export.csv')}>
              CSV 내려받기
            </button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#868e96', marginTop: -6, marginBottom: 12 }}>
          직전 동일기간 대비 증감률, 엔지니어 편중도(한 명이 몇 %를 담당하는지)를 같이 보여드려서 재계약·리스크 판단에 참고하실 수 있습니다.
        </p>

        {effort && effort.clients.length > 0 && (
          <div className="macro-tile" style={{ borderLeftColor: '#2f6feb', marginBottom: 12, display: 'inline-flex' }}>
            <div className="macro-tile-icon">⏱️</div>
            <div>
              <div className="macro-tile-label">선택된 조건 총 공수</div>
              <div className="macro-tile-value" style={{ color: '#2f6feb' }}>{hoursLabel(effortTotalMinutes)}</div>
            </div>
          </div>
        )}

        {!effort && <div className="board-empty">불러오는 중...</div>}
        {effort && effort.clients.length === 0 && <div className="board-empty">이 조건에 등록된(완료된) 공수기록이 없습니다.</div>}
        {effort && effort.clients.map((client) => {
          const isClientExpanded = expandedProjects[`client::${client.clientName}`] ?? false;
          return (
            <div key={client.clientName} className="board-column" style={{ marginBottom: 10, borderTopColor: '#2f6feb' }}>
              <div className="board-column-header" style={{ cursor: 'pointer' }} onClick={() => toggleProject(`client::${client.clientName}`)}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, transform: isClientExpanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                  {' '}🏢 {client.clientName}
                  <span style={{ color: '#868e96', fontWeight: 400 }}> · 프로젝트 {client.projectCount}개 · 엔지니어 {client.engineerCount}명</span>
                </span>
                <span className="count">{hoursLabel(client.totalMinutes)}</span>
              </div>

              {/* 관리 판단용 배지들 */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 14px' }}>
                {client.topWorkType && (
                  <span style={{ fontSize: 12, background: '#f1f3f5', borderRadius: 999, padding: '3px 10px' }}>
                    {WORK_TYPE_ICONS[client.topWorkType] ?? '📌'} 주요유형: {client.topWorkType}
                  </span>
                )}
                {client.topEngineerName && (
                  <span
                    style={{
                      fontSize: 12, borderRadius: 999, padding: '3px 10px',
                      background: client.concentrationPct >= 70 ? '#fff0e6' : '#f1f3f5',
                      color: client.concentrationPct >= 70 ? '#e8590c' : '#495057',
                    }}
                  >
                    {client.concentrationPct >= 70 ? '⚠ ' : ''}담당 편중: {client.topEngineerName} {client.concentrationPct}%
                  </span>
                )}
                {client.trendPct !== null && (
                  <span
                    style={{
                      fontSize: 12, borderRadius: 999, padding: '3px 10px',
                      background: client.trendPct > 0 ? '#eaf1ff' : client.trendPct < 0 ? '#f1f3f5' : '#f1f3f5',
                      color: client.trendPct > 0 ? '#2f6feb' : client.trendPct < 0 ? '#868e96' : '#495057',
                    }}
                  >
                    {client.trendPct > 0 ? '📈' : client.trendPct < 0 ? '📉' : '➖'} 전기간 대비 {client.trendPct > 0 ? '+' : ''}{client.trendPct}%
                  </span>
                )}
              </div>

              {isClientExpanded && client.projects.map((row) => {
                const key = `${row.clientName}::${row.projectName}`;
                const isProjectExpanded = expandedProjects[key] ?? false;
                return (
                  <div key={key} style={{ margin: '0 14px 8px', border: '1px solid #eee', borderRadius: 8 }}>
                    <div className="board-column-header" style={{ cursor: 'pointer', padding: '8px 10px' }} onClick={() => toggleProject(key)}>
                      <span>
                        <span style={{ display: 'inline-block', width: 12, transform: isProjectExpanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                        {' '}{row.workTypes.map((t) => WORK_TYPE_ICONS[t] ?? '📌').join('')} {row.projectName}
                      </span>
                      <span className="count">{hoursLabel(row.totalMinutes)}</span>
                    </div>
                    {isProjectExpanded && row.byUser.map((u) => (
                      <div className="employee-chip" key={u.userId} style={{ margin: '0 10px 8px' }}>
                        <div className="chip-row">
                          <div className="chip-avatar" style={{ background: '#2f6feb' }}>{u.name.slice(-2)}</div>
                          <div style={{ flex: 1 }}>
                            <div className="name">{u.name}</div>
                            <div className="meta">{hoursLabel(u.minutes)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {timelineTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, maxWidth: 560, width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
            {!timeline && <div className="board-empty">불러오는 중...</div>}
            {timeline && (
              <>
                <h2 style={{ marginTop: 0 }}>🕒 {timeline.name}님의 {timeline.date} 상세 타임라인</h2>
                <p style={{ fontSize: 13, color: '#495057' }}>
                  {timeline.department} · 출근 {fmtTime(timeline.clockInAt)} · 퇴근 {timeline.clockOutAt ? fmtTime(timeline.clockOutAt) : '진행중'}
                  {timeline.totalWorkedMinutes != null && ` · 근무시간 ${hoursLabel(timeline.totalWorkedMinutes)}`}
                  {timeline.clockOutLocation && ` · 📍 ${timeline.clockOutLocation}`}
                </p>
                {timeline.timeline.length === 0 && <div className="board-empty">이 날짜에 등록된 상태 변경이 없습니다.</div>}
                {timeline.timeline.map((t, i) => {
                  const meta = TIMELINE_STATUS_META[t.status] ?? { label: t.status, icon: '❔', color: '#868e96' };
                  return (
                    <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f3f5' }}>
                      <div style={{ fontSize: 20 }}>{meta.icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong style={{ color: meta.color }}>{meta.label}</strong>
                          <span style={{ fontSize: 13, color: '#495057' }}>
                            {fmtTime(t.changedAt)} · {t.ongoing ? <span style={{ color: '#f08c00' }}>진행중</span> : hoursLabel(t.durationMinutes)}
                          </span>
                        </div>
                        {t.note && <div style={{ fontSize: 12, color: '#868e96', marginTop: 2, fontStyle: 'italic' }}>“{t.note}”</div>}
                      </div>
                    </div>
                  );
                })}
                {/* 목록 맨 아래에 퇴근도 같은 형식(아이콘/시간/부가정보 한 줄)으로 보여준다 —
                    위쪽 요약줄("출근 .. · 퇴근 ..")과 별개로, 몇 시에 어디서 퇴근했는지 더 자세히 볼 수 있게. */}
                {timeline.clockOutAt && (
                  <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f3f5' }}>
                    <div style={{ fontSize: 20 }}>🚪</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong style={{ color: '#2f6feb' }}>퇴근</strong>
                        <span style={{ fontSize: 13, color: '#495057' }}>{fmtTime(timeline.clockOutAt)}</span>
                      </div>
                      {timeline.clockOutLocation && (
                        <div style={{ fontSize: 12, color: '#868e96', marginTop: 2, fontStyle: 'italic' }}>“📍 {timeline.clockOutLocation}”</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
            <button className="secondary" style={{ marginTop: 12 }} onClick={() => { setTimelineTarget(null); setTimeline(null); }}>닫기</button>
          </div>
        </div>
      )}
    </div>
  );
}
