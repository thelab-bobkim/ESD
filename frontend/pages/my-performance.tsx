import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

// ESD 2.0 Phase 1 (2026-10-01 추가, 사용자 요청사항 5 — 직원 개인 화면)
// "회사가 나를 어떤 데이터로 평가하는지" 직원 본인이 직접 확인할 수 있어야 한다는 요구사항.
// ChatGPT가 작성한 원래 패치(projects.routes.ts)에는 이 화면을 설명하는 주석만 파일 맨 끝에
// 남아 있었고, 실제 백엔드 엔드포인트와 화면 모두 빠져 있었다(검증 중 발견) — 이 페이지와
// backend/src/modules/projects/projects.routes.ts의 GET /me/performance 로 새로 구현했다.
type Task = { id: string; title: string; status: string; dueDate: string | null; completedAt: string | null; difficulty: number; plannedMinutes: number | null; project: { id: string; code: string; name: string } };
type MyPerformance = {
  from: string; to: string; projectCount: number;
  projects: { id: string; code: string; name: string; status: string }[];
  actualMinutes: number; effortEntryCount: number; assignedTasks: number; completedTasks: number;
  overdueTasks: number; blockedTasks: number; plannedTaskMinutes: number; averageTaskDifficulty: number;
  completionRate: number | null; tasks: Task[];
};
const TASK_STATUS_LABEL: Record<string, string> = { TODO: '대기', IN_PROGRESS: '진행', BLOCKED: '막힘', DONE: '완료' };
function h(m: number) { return (m / 60).toFixed(1); }
function fmt(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

export default function MyPerformancePage() {
  const router = useRouter();
  const [anchor, setAnchor] = useState(new Date());
  const [data, setData] = useState<MyPerformance | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const from = fmt(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const to = fmt(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
    setLoading(true); setError('');
    apiFetch<MyPerformance>(`/projects/me/performance?from=${from}&to=${to}`)
      .then(setData)
      .catch((e) => { if (isAuthExpiredError(e)) { router.push('/login'); return; } setError(e instanceof Error ? e.message : '불러오지 못했습니다.'); })
      .finally(() => setLoading(false));
  }, [anchor, router]);

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ marginBottom: 0 }}>내 프로젝트 성과</h1>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => router.push('/')}>← 돌아가기</button>
      </div>
      <p style={{ color: '#6b7280' }}>이 화면은 순위나 자동 평가점수를 보여주지 않습니다. 회사가 참고하는 것과 같은 원본 데이터(참여 프로젝트, 배정/완료 Task, 실공수, 지연 여부)를 그대로 보여드립니다.</p>
      {error && <div className="error">{error}</div>}
      <div className="toolbar">
        <button className="secondary" style={{ width: 'auto' }} onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>‹ 이전달</button>
        <b>{anchor.getFullYear()}년 {anchor.getMonth() + 1}월</b>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>다음달 ›</button>
      </div>
      {loading ? <p>불러오는 중...</p> : data && (
        <>
          <div className="stat-row">
            <div className="stat-card"><div className="stat-label">참여 프로젝트</div><div className="stat-value">{data.projectCount}건</div></div>
            <div className="stat-card"><div className="stat-label">실공수</div><div className="stat-value">{h(data.actualMinutes)}h</div></div>
            <div className="stat-card"><div className="stat-label">완료 Task</div><div className="stat-value">{data.completedTasks}건</div></div>
            <div className="stat-card"><div className="stat-label">기한초과 Task</div><div className="stat-value">{data.overdueTasks}건</div></div>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>요약</h3>
            <p>
              이번 달 프로젝트 참여 {data.projectCount}건, 실공수 {h(data.actualMinutes)}시간, 배정 Task {data.assignedTasks}건 중 완료 {data.completedTasks}건
              {data.completionRate != null ? ` (완료율 ${data.completionRate}%)` : ''}, 기한초과 Task {data.overdueTasks}건, 막힘 Task {data.blockedTasks}건, 평균 난이도 {data.averageTaskDifficulty || '-'}.
            </p>
            {data.projects.length > 0 && (
              <p style={{ color: '#6b7280' }}>참여 프로젝트: {data.projects.map((p) => `${p.code}·${p.name}`).join(', ')}</p>
            )}
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>이번 기간 Task</h3>
            {data.tasks.length === 0 ? <p>해당 기간에 표시할 Task가 없습니다.</p> : (
              <div className="table-scroll">
                <table className="att-table">
                  <thead><tr><th>프로젝트</th><th>Task</th><th>난이도</th><th>예상</th><th>기한</th><th>상태</th></tr></thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <tr key={t.id}>
                        <td>{t.project.code} · {t.project.name}</td>
                        <td>{t.title}</td>
                        <td className="num">{t.difficulty}</td>
                        <td className="num">{h(t.plannedMinutes ?? 0)}h</td>
                        <td>{t.dueDate ?? '-'}</td>
                        <td>{TASK_STATUS_LABEL[t.status] ?? t.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p style={{ fontSize: 12, color: '#6b7280', marginTop: 14 }}>
              ※ 기록이 사실과 다르다고 생각되면 팀장/관리자에게 알려주세요. 정정·이의제기 기능은 추후 추가될 예정입니다.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
