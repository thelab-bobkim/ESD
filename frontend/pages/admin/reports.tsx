import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload, clearToken } from '@/lib/api';

const WEEKLY_LIMIT_MINUTES = 52 * 60; // 주52시간제 기준
type Period = 'day' | 'week' | 'month' | 'year';
const PERIOD_LABELS: Record<Period, string> = { day: '일', week: '주', month: '월', year: '년' };
const WORK_TYPE_OPTIONS = ['정기점검', '신규설치', '장애대응', '미팅', '기타'];
const WORK_TYPE_ICONS: Record<string, string> = { 정기점검: '🔧', 신규설치: '🆕', 장애대응: '🚨', 미팅: '🤝', 기타: '📌' };

interface WorktimeRow {
  userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number;
}
interface WorktimeSummary { from: string; to: string; rows: WorktimeRow[]; }

interface AttendanceDetailRow {
  userId: string; employeeNo: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; totalWorkedMinutes: number | null;
}
interface AttendanceDetail { date: string; rows: AttendanceDetailRow[]; }

interface EffortByUser { userId: string; name: string; minutes: number; }
interface EffortRow { projectName: string; clientName: string; totalMinutes: number; workTypes: string[]; byUser: EffortByUser[]; }
interface EffortSummary { from: string; to: string; rows: EffortRow[]; }

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

  const range = useMemo(() => computeRange(period, anchor), [period, anchor]);

  useEffect(() => {
    setError(null);
    const fromStr = fmt(range.from);
    const toStr = fmt(range.to);

    if (period === 'day') {
      setWorktime(null);
      apiFetch<AttendanceDetail>(`/reports/attendance-detail?date=${fromStr}`)
        .then(setAttendanceDetail)
        .catch((err) => {
          if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
          setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
        });
    } else {
      setAttendanceDetail(null);
      apiFetch<WorktimeSummary>(`/reports/worktime-summary?from=${fromStr}&to=${toStr}`)
        .then(setWorktime)
        .catch((err) => setError(err instanceof Error ? err.message : '오류가 발생했습니다.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, range.from.getTime(), range.to.getTime()]);

  useEffect(() => {
    const fromStr = fmt(range.from);
    const toStr = fmt(range.to);
    apiFetch<EffortSummary>(`/reports/effort-summary?from=${fromStr}&to=${toStr}&workType=${workTypeFilter}`)
      .then(setEffort)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from.getTime(), range.to.getTime(), workTypeFilter]);

  function toggleProject(key: string) {
    setExpandedProjects((prev) => ({ ...prev, [key]: !prev[key] }));
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

  const periodSummary = useMemo(() => {
    if (!worktime) return null;
    const total = worktime.rows.length;
    const totalMinutes = worktime.rows.reduce((s, r) => s + r.totalMinutes, 0);
    const avgMinutes = total > 0 ? Math.round(totalMinutes / total) : 0;
    const overCount = period === 'week' ? worktime.rows.filter((r) => r.totalMinutes > WEEKLY_LIMIT_MINUTES).length : 0;
    return { total, avgMinutes, overCount };
  }, [worktime, period]);

  const effortTotalMinutes = useMemo(() => (effort ? effort.rows.reduce((s, r) => s + r.totalMinutes, 0) : 0), [effort]);

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
          <button key={p} className={period === p ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => setPeriod(p)}>
            {PERIOD_LABELS[p]}별
          </button>
        ))}
        <div className="spacer" />
        <button className="secondary" style={{ width: 'auto' }} onClick={() => setAnchor(shiftAnchor(period, anchor, -1))}>‹ 이전</button>
        <span style={{ fontWeight: 700, minWidth: 140, textAlign: 'center' }}>{range.label}</span>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => setAnchor(shiftAnchor(period, anchor, 1))}>다음 ›</button>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => setAnchor(new Date())}>오늘</button>
      </div>

      {/* 요약 카드 */}
      {period === 'day' && daySummary && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">👥 오늘 활동 인원</div>
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
      {period !== 'day' && periodSummary && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">👥 근무 인원</div>
            <div className="stat-value">{periodSummary.total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">⏱️ 1인 평균</div>
            <div className="stat-value">{hoursLabel(periodSummary.avgMinutes)}</div>
          </div>
          {period === 'week' && (
            <div className="stat-card">
              <div className="stat-label">⚠️ 52시간 초과</div>
              <div className="stat-value" style={{ color: periodSummary.overCount > 0 ? '#e03131' : '#495057' }}>{periodSummary.overCount}명</div>
            </div>
          )}
        </div>
      )}

      {/* 일(day) 선택 시: 출퇴근 상세표 */}
      {period === 'day' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>🕒 출퇴근 현황 — {range.label}</h2>
            <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
              CSV 내려받기
            </button>
          </div>
          {!attendanceDetail && <div className="board-empty">불러오는 중...</div>}
          {attendanceDetail && attendanceDetail.rows.length === 0 && <div className="board-empty">이 날짜에 출근 기록이 없습니다.</div>}
          {attendanceDetail && attendanceDetail.rows.length > 0 && (
            <table>
              <thead>
                <tr><th>이름</th><th>부서</th><th>출근</th><th>퇴근</th><th>근무시간</th></tr>
              </thead>
              <tbody>
                {attendanceDetail.rows.map((r) => (
                  <tr key={r.userId}>
                    <td>
                      <div className="chip-row">
                        <div className="chip-avatar" style={{ background: r.clockOutAt ? '#2f9e44' : '#f08c00' }}>{r.name.slice(-2)}</div>
                        {r.name}
                      </div>
                    </td>
                    <td>{r.department}</td>
                    <td>{fmtTime(r.clockInAt)}</td>
                    <td>{r.clockOutAt ? fmtTime(r.clockOutAt) : <span style={{ color: '#f08c00', fontWeight: 600 }}>● 진행중</span>}</td>
                    <td>{r.totalWorkedMinutes != null ? hoursLabel(r.totalWorkedMinutes) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 주/월/년 선택 시: 누적 근무시간 표 */}
      {period !== 'day' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>📊 {PERIOD_LABELS[period]}별 근무시간 누계 (주52시간제 기준) — {range.label}</h2>
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
                  const over = period === 'week' && r.totalMinutes > WEEKLY_LIMIT_MINUTES;
                  return (
                    <tr key={r.userId}>
                      <td>
                        <div className="chip-row">
                          <div className="chip-avatar" style={{ background: over ? '#e03131' : '#2f6feb' }}>{r.name.slice(-2)}</div>
                          {r.name}
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

      {/* 프로젝트별 공수 + 작업유형 드롭다운 필터 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2>🛠️ 프로젝트별 공수(工數) — {range.label}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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

        {effort && effort.rows.length > 0 && (
          <div className="macro-tile" style={{ borderLeftColor: '#2f6feb', marginBottom: 12, display: 'inline-flex' }}>
            <div className="macro-tile-icon">⏱️</div>
            <div>
              <div className="macro-tile-label">선택된 조건 총 공수</div>
              <div className="macro-tile-value" style={{ color: '#2f6feb' }}>{hoursLabel(effortTotalMinutes)}</div>
            </div>
          </div>
        )}

        {!effort && <div className="board-empty">불러오는 중...</div>}
        {effort && effort.rows.length === 0 && <div className="board-empty">이 조건에 등록된(완료된) 공수기록이 없습니다.</div>}
        {effort && effort.rows.map((row) => {
          const key = `${row.clientName}::${row.projectName}`;
          const isExpanded = expandedProjects[key] ?? false;
          return (
            <div key={key} className="board-column" style={{ marginBottom: 10, borderTopColor: '#2f6feb' }}>
              <div className="board-column-header" style={{ cursor: 'pointer' }} onClick={() => toggleProject(key)}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, transform: isExpanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                  {' '}{row.workTypes.map((t) => WORK_TYPE_ICONS[t] ?? '📌').join('')} {row.projectName}
                  <span style={{ color: '#868e96', fontWeight: 400 }}> · {row.clientName}</span>
                </span>
                <span className="count">{hoursLabel(row.totalMinutes)}</span>
              </div>
              {isExpanded && row.byUser.map((u) => (
                <div className="employee-chip" key={u.userId}>
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
    </div>
  );
}
