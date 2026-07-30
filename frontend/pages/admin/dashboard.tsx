import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';

const STATUS_LABELS: Record<string, string> = {
  HQ_WORKING: '본사근무', RESIDENT_ONSITE: '고객사상주', OFFSITE: '외근', MEETING: '회의',
  MOVING: '이동', REMOTE: '재택', NIGHT_WORK: '야간작업', ALT_DAY_OFF: '대체휴무', ON_LEAVE: '휴가', UNKNOWN: '미확인',
};

const STATUS_COLORS: Record<string, string> = {
  HQ_WORKING: '#2f9e44', RESIDENT_ONSITE: '#2f9e44', OFFSITE: '#1c7ed6', MEETING: '#1c7ed6', MOVING: '#1c7ed6',
  REMOTE: '#868e96', ALT_DAY_OFF: '#868e96', ON_LEAVE: '#868e96', NIGHT_WORK: '#f08c00', UNKNOWN: '#e03131',
};

interface EmployeeRow {
  userId: string; name: string; department: string; client: string | null; workType: string;
  status: string | null; statusChangedAt: string | null; lastConfirmedAt: string | null;
}

interface CompanyBoard { summary: Record<string, number>; employees: EmployeeRow[]; }

interface AlertRow { ruleCode: string; userId: string; relatedId?: string; severity: string; }

const ALERT_LABELS: Record<string, string> = {
  NO_CLOCK_IN: '미출근', LONG_WORKING: '장시간근무', NIGHT_WORK_NOT_CONVERTED: '야간근무 후 미전환', STATUS_NOT_CONFIRMED: '상태 미확인',
};

export default function AdminDashboard() {
  const router = useRouter();
  const [board, setBoard] = useState<CompanyBoard | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<CompanyBoard>('/dashboard/company'),
      apiFetch<AlertRow[]>('/alerts'),
    ])
      .then(([b, a]) => {
        setBoard(b);
        setAlerts(a);
      })
      .catch((err) => {
        if (err instanceof Error && err.message.includes('로그인')) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
  }, [router]);

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>전사 상황판</h1>
        <button className="secondary" style={{ width: 'auto' }} onClick={logout}>로그아웃</button>
      </div>
      {error && <div className="error">{error}</div>}

      {board && (
        <div className="card">
          <h2>상태별 인원 요약</h2>
          <div className="status-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            {Object.entries(board.summary).map(([status, count]) => (
              <div key={status} className="status-badge">
                <span className="status-tag" style={{ background: STATUS_COLORS[status] || '#868e96' }}>
                  {STATUS_LABELS[status] || status}
                </span>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 700 }}>{count}명</div>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {board && (
        <div className="card">
          <h2>전직원 현황</h2>
          <table>
            <thead>
              <tr><th>이름</th><th>소속</th><th>고객사</th><th>근무유형</th><th>현재 상태</th><th>상태변경시각</th></tr>
            </thead>
            <tbody>
              {board.employees.map((e) => (
                <tr key={e.userId}>
                  <td>{e.name}</td>
                  <td>{e.department}</td>
                  <td>{e.client ?? '-'}</td>
                  <td>{e.workType}</td>
                  <td>
                    <span className="status-tag" style={{ background: STATUS_COLORS[e.status || 'UNKNOWN'] || '#868e96' }}>
                      {STATUS_LABELS[e.status || 'UNKNOWN']}
                    </span>
                  </td>
                  <td>{e.statusChangedAt ? new Date(e.statusChangedAt).toLocaleString('ko-KR') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
