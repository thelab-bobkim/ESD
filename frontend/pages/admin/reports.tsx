import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload, clearToken } from '@/lib/api';

const WEEKLY_LIMIT_MINUTES = 52 * 60; // 주52시간제 기준

interface WorktimeRow {
  userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number;
}
interface WorktimeSummary { from: string; to: string; rows: WorktimeRow[]; }

interface EffortByUser { userId: string; name: string; minutes: number; }
interface EffortRow { projectName: string; clientName: string; totalMinutes: number; byUser: EffortByUser[]; }
interface EffortSummary { from: string; to: string; rows: EffortRow[]; }

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0=일요일
  const diff = day === 0 ? -6 : 1 - day; // 월요일 기준
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday;
}

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

export default function AdminReportsPage() {
  const router = useRouter();
  const [weekly, setWeekly] = useState<WorktimeSummary | null>(null);
  const [monthly, setMonthly] = useState<WorktimeSummary | null>(null);
  const [effort, setEffort] = useState<EffortSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const now = new Date();
    const monday = startOfWeek(now);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const weekFrom = fmtDate(monday);
    const weekTo = fmtDate(sunday);
    const monthFrom = fmtDate(monthStart);
    const monthTo = fmtDate(monthEnd);

    Promise.all([
      apiFetch<WorktimeSummary>(`/reports/worktime-summary?from=${weekFrom}&to=${weekTo}`),
      apiFetch<WorktimeSummary>(`/reports/worktime-summary?from=${monthFrom}&to=${monthTo}`),
      apiFetch<EffortSummary>(`/reports/effort-summary?from=${monthFrom}&to=${monthTo}`),
    ])
      .then(([w, m, e]) => {
        setWeekly(w);
        setMonthly(m);
        setEffort(e);
      })
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monthlyByUser = new Map((monthly?.rows ?? []).map((r) => [r.userId, r]));

  function toggleProject(key: string) {
    setExpandedProjects((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="admin-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>근로시간 · 공수 리포트</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/admin/dashboard')}>상황판으로</button>
          <button className="secondary" style={{ width: 'auto' }} onClick={logout}>로그아웃</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>이번 주 근무시간 (주52시간제 기준){weekly ? ` — ${weekly.from} ~ ${weekly.to}` : ''}</h2>
          <button
            style={{ width: 'auto', margin: 0 }}
            className="secondary"
            onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}
          >
            근태 CSV 내려받기
          </button>
        </div>
        {!weekly && <div className="board-empty">불러오는 중...</div>}
        {weekly && weekly.rows.length === 0 && <div className="board-empty">이번 주 확정된 근무기록이 없습니다.</div>}
        {weekly && weekly.rows.length > 0 && (
          <table>
            <thead>
              <tr><th>이름</th><th>부서</th><th>이번주 누계</th><th>이번달 누계</th><th>근무일수(주)</th></tr>
            </thead>
            <tbody>
              {weekly.rows.map((r) => {
                const over = r.totalMinutes > WEEKLY_LIMIT_MINUTES;
                const monthRow = monthlyByUser.get(r.userId);
                return (
                  <tr key={r.userId}>
                    <td>{r.name}</td>
                    <td>{r.department}</td>
                    <td style={{ color: over ? '#e03131' : undefined, fontWeight: over ? 700 : undefined }}>
                      {hoursLabel(r.totalMinutes)}{over ? ' ⚠ 52시간 초과' : ''}
                    </td>
                    <td>{monthRow ? hoursLabel(monthRow.totalMinutes) : '-'}</td>
                    <td>{r.days}일</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>프로젝트별 공수(工數) — 이번 달</h2>
          <button
            style={{ width: 'auto', margin: 0 }}
            className="secondary"
            onClick={() => apiDownload('/reports/effort-export', 'effort-export.csv')}
          >
            공수 CSV 내려받기
          </button>
        </div>
        {!effort && <div className="board-empty">불러오는 중...</div>}
        {effort && effort.rows.length === 0 && <div className="board-empty">이번 달 등록된(완료된) 공수기록이 없습니다.</div>}
        {effort && effort.rows.map((row) => {
          const key = `${row.clientName}::${row.projectName}`;
          const isExpanded = expandedProjects[key] ?? false;
          return (
            <div key={key} className="board-column" style={{ marginBottom: 10, borderTopColor: '#2f6feb' }}>
              <div className="board-column-header" style={{ cursor: 'pointer' }} onClick={() => toggleProject(key)}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, transform: isExpanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                  {' '}{row.projectName} <span style={{ color: '#868e96', fontWeight: 400 }}>· {row.clientName}</span>
                </span>
                <span className="count">{hoursLabel(row.totalMinutes)}</span>
              </div>
              {isExpanded && row.byUser.map((u) => (
                <div className="employee-chip" key={u.userId}>
                  <div className="name">{u.name}</div>
                  <div className="meta">{hoursLabel(u.minutes)}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
