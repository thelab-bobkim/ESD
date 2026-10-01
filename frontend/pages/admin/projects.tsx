import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import AdminHeader from '@/components/AdminHeader';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

type RefUser = { id: string; name: string; employeeNo: string; department: string };
type RefClient = { id: string; name: string };
type ProjectRow = {
  id: string; code: string; name: string; status: string; priority: string; difficulty: number;
  plannedMinutes: number | null; actualMinutes: number; startDate: string | null; endDate: string | null; description: string | null;
  client: RefClient | null; manager: { id: string; name: string; department: string } | null;
  members: { id: string; userId: string; name: string; department: string; role: string; allocationPct: number }[];
  taskSummary: { total: number; done: number; inProgress: number; blocked: number };
};
type ProjectDetail = {
  id: string; code: string; name: string;
  members: { id: string; userId: string; role: string; allocationPct: number; user: { id: string; name: string; department: { name: string } } }[];
  tasks: { id: string; title: string; status: string; priority: string; difficulty: number; plannedMinutes: number | null; dueDate: string | null; assigneeId: string | null; assignee: { id: string; name: string } | null; effortLogs: { actualMinutes: number | null; minutes: number | null }[] }[];
};

const STATUS_LABEL: Record<string, string> = { PLANNED: '준비', ACTIVE: '진행', ON_HOLD: '보류', COMPLETED: '완료', CANCELLED: '취소' };
const TASK_STATUS_LABEL: Record<string, string> = { TODO: '대기', IN_PROGRESS: '진행', BLOCKED: '막힘', DONE: '완료' };
function hours(minutes: number | null | undefined) { return `${((minutes ?? 0) / 60).toFixed(1)}h`; }

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [users, setUsers] = useState<RefUser[]>([]);
  const [clients, setClients] = useState<RefClient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', clientId: '', managerId: '', status: 'PLANNED', priority: 'NORMAL', difficulty: 3, startDate: '', endDate: '', plannedHours: '', description: '' });
  const [memberUserId, setMemberUserId] = useState('');
  const [task, setTask] = useState({ title: '', assigneeId: '', difficulty: 3, plannedHours: '', dueDate: '' });

  async function loadAll(preferId?: string) {
    try {
      setError('');
      const [rows, refs] = await Promise.all([
        apiFetch<ProjectRow[]>('/projects'),
        apiFetch<{ users: RefUser[]; clients: RefClient[] }>('/projects/reference-data'),
      ]);
      setProjects(rows); setUsers(refs.users); setClients(refs.clients);
      const id = preferId || selectedId || rows[0]?.id || '';
      setSelectedId(id);
      if (id) setDetail(await apiFetch<ProjectDetail>(`/projects/${id}`)); else setDetail(null);
    } catch (e) {
      if (isAuthExpiredError(e)) { router.push('/login'); return; }
      setError(e instanceof Error ? e.message : '프로젝트 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { if (selectedId) apiFetch<ProjectDetail>(`/projects/${selectedId}`).then(setDetail).catch(() => {}); }, [selectedId]);

  const selected = useMemo(() => projects.find((p) => p.id === selectedId) ?? null, [projects, selectedId]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const created = await apiFetch<{ id: string }>('/projects', { method: 'POST', body: JSON.stringify({
        code: form.code.trim(), name: form.name.trim(), clientId: form.clientId || null, managerId: form.managerId || null,
        status: form.status, priority: form.priority, difficulty: Number(form.difficulty),
        plannedMinutes: form.plannedHours ? Math.round(Number(form.plannedHours) * 60) : null,
        startDate: form.startDate || null, endDate: form.endDate || null, description: form.description || null,
      }) });
      setForm({ code: '', name: '', clientId: '', managerId: '', status: 'PLANNED', priority: 'NORMAL', difficulty: 3, startDate: '', endDate: '', plannedHours: '', description: '' });
      await loadAll(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : '생성하지 못했습니다.'); } finally { setBusy(false); }
  }

  async function addMember() {
    if (!selectedId || !memberUserId) return;
    try {
      await apiFetch(`/projects/${selectedId}/members`, { method: 'POST', body: JSON.stringify({ userId: memberUserId, role: 'MEMBER', allocationPct: 100 }) });
      setMemberUserId(''); await loadAll(selectedId);
    } catch (e) { setError(e instanceof Error ? e.message : '참여자를 추가하지 못했습니다.'); }
  }
  async function addTask() {
    if (!selectedId || !task.title.trim()) return;
    try {
      await apiFetch(`/projects/${selectedId}/tasks`, { method: 'POST', body: JSON.stringify({ title: task.title.trim(), assigneeId: task.assigneeId || null, difficulty: Number(task.difficulty), plannedMinutes: task.plannedHours ? Math.round(Number(task.plannedHours) * 60) : null, dueDate: task.dueDate || null }) });
      setTask({ title: '', assigneeId: '', difficulty: 3, plannedHours: '', dueDate: '' }); await loadAll(selectedId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Task를 추가하지 못했습니다.'); }
  }
  async function setProjectStatus(status: string) {
    if (!selectedId) return;
    try { await apiFetch(`/projects/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadAll(selectedId); }
    catch (e) { setError(e instanceof Error ? e.message : '상태를 변경하지 못했습니다.'); }
  }
  async function setTaskStatus(taskId: string, status: string) {
    try { await apiFetch(`/projects/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadAll(selectedId); }
    catch (e) { setError(e instanceof Error ? e.message : 'Task 상태를 변경하지 못했습니다.'); }
  }

  return <div className="admin-shell">
    <AdminHeader title="ESD 2.0 프로젝트관리" />
    <p className="admin-page-subtitle">프로젝트·참여 엔지니어·Task·실공수를 연결합니다. 기존 공수기록(자유입력)은 그대로 보존됩니다.</p>
    {error && <div className="error">{error}</div>}
    {loading && <p>불러오는 중...</p>}
    {!loading && <>

    <div className="stat-row">
      <div className="stat-card"><div className="stat-label">전체 프로젝트</div><div className="stat-value">{projects.length}</div></div>
      <div className="stat-card"><div className="stat-label">진행중</div><div className="stat-value">{projects.filter(p => p.status === 'ACTIVE').length}</div></div>
      <div className="stat-card"><div className="stat-label">완료</div><div className="stat-value">{projects.filter(p => p.status === 'COMPLETED').length}</div></div>
      <div className="stat-card"><div className="stat-label">지연 확인 필요</div><div className="stat-value">{projects.filter(p => p.endDate && p.status !== 'COMPLETED' && p.status !== 'CANCELLED' && new Date(p.endDate) < new Date()).length}</div></div>
    </div>

    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>신규 프로젝트</h2>
      <form onSubmit={createProject}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
          <div><label className="field-label">프로젝트 코드</label><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="예: NH-2026-001" required /></div>
          <div><label className="field-label">프로젝트명</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="field-label">고객사</label><select className="field-select" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">선택 안 함</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label className="field-label">PM</label><select className="field-select" value={form.managerId} onChange={e => setForm({ ...form, managerId: e.target.value })}><option value="">미지정</option>{users.map(u => <option key={u.id} value={u.id}>{u.name} · {u.department}</option>)}</select></div>
          <div><label className="field-label">상태</label><select className="field-select" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{Object.entries(STATUS_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label className="field-label">난이도(1~5)</label><input type="number" min={1} max={5} value={form.difficulty} onChange={e => setForm({ ...form, difficulty: Number(e.target.value) })} /></div>
          <div><label className="field-label">예상공수(h)</label><input type="number" min={0} step="0.5" value={form.plannedHours} onChange={e => setForm({ ...form, plannedHours: e.target.value })} /></div>
          <div><label className="field-label">시작일</label><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></div>
          <div><label className="field-label">종료예정일</label><input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></div>
        </div>
        <label className="field-label">설명</label><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} />
        <button type="submit" disabled={busy}>{busy ? '생성 중...' : '프로젝트 생성'}</button>
      </form>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px,0.9fr) minmax(420px,1.6fr)', gap: 16 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>프로젝트 목록 ({projects.length})</h2>
        {projects.length === 0 && <p>등록된 프로젝트가 없습니다. 위에서 먼저 생성하세요.</p>}
        {projects.map(p => <button key={p.id} type="button" onClick={() => setSelectedId(p.id)} className={selectedId === p.id ? '' : 'secondary'} style={{ width: '100%', textAlign: 'left', marginBottom: 8 }}>
          <b>{p.code}</b> · {p.name}<br/><small>{STATUS_LABEL[p.status] ?? p.status} · {p.manager?.name ?? 'PM 미지정'} · 실공수 {hours(p.actualMinutes)}</small>
        </button>)}
      </div>
      <div className="card">
        {!selected || !detail ? <p>프로젝트를 선택하세요.</p> : <>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div><h2 style={{ margin: 0 }}>{selected.name}</h2><p style={{ margin: '6px 0', color: '#6b7280' }}>{selected.code} · {selected.client?.name ?? '고객사 미지정'}</p></div>
            <select className="field-select" style={{ width: 'auto' }} value={selected.status} onChange={e => setProjectStatus(e.target.value)}>{Object.entries(STATUS_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select>
          </div>
          <div className="stat-row" style={{ marginTop: 12 }}>
            <div className="stat-card"><div className="stat-label">예상공수</div><div className="stat-value">{hours(selected.plannedMinutes)}</div></div>
            <div className="stat-card"><div className="stat-label">실공수</div><div className="stat-value">{hours(selected.actualMinutes)}</div></div>
            <div className="stat-card"><div className="stat-label">Task 완료</div><div className="stat-value">{selected.taskSummary.done}/{selected.taskSummary.total}</div></div>
            <div className="stat-card"><div className="stat-label">난이도</div><div className="stat-value">{selected.difficulty}</div></div>
          </div>

          <h3>참여 엔지니어</h3>
          {detail.members.length === 0 ? <p>아직 참여자가 없습니다.</p> : <div className="table-scroll"><table><thead><tr><th>이름</th><th>부서</th><th>역할</th><th>배정</th></tr></thead><tbody>{detail.members.map(m => <tr key={m.id}><td>{m.user.name}</td><td>{m.user.department.name}</td><td>{m.role}</td><td>{m.allocationPct}%</td></tr>)}</tbody></table></div>}
          <div className="toolbar" style={{ marginTop: 8 }}><select className="field-select" style={{ margin:0 }} value={memberUserId} onChange={e => setMemberUserId(e.target.value)}><option value="">참여자 선택</option>{users.filter(u => !detail.members.some(m => m.userId === u.id)).map(u => <option key={u.id} value={u.id}>{u.name} · {u.department}</option>)}</select><button type="button" style={{ width:'auto' }} onClick={addMember} disabled={!memberUserId}>참여자 추가</button></div>

          <h3>Task</h3>
          {detail.tasks.length === 0 ? <p>아직 Task가 없습니다.</p> : <div className="table-scroll"><table><thead><tr><th>Task</th><th>담당</th><th>난이도</th><th>예상</th><th>실공수</th><th>기한</th><th>상태</th></tr></thead><tbody>{detail.tasks.map(t => <tr key={t.id}><td>{t.title}</td><td>{t.assignee?.name ?? '-'}</td><td>{t.difficulty}</td><td>{hours(t.plannedMinutes)}</td><td>{hours(t.effortLogs.reduce((s,e)=>s+(e.actualMinutes ?? e.minutes ?? 0),0))}</td><td>{t.dueDate ? t.dueDate.slice(0,10) : '-'}</td><td><select className="field-select" style={{ margin:0, minWidth:90 }} value={t.status} onChange={e => setTaskStatus(t.id,e.target.value)}>{Object.entries(TASK_STATUS_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></td></tr>)}</tbody></table></div>}
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1.3fr .7fr .8fr 1fr auto', gap:8, marginTop:10, alignItems:'end' }}>
            <div><label className="field-label">Task명</label><input value={task.title} onChange={e=>setTask({...task,title:e.target.value})}/></div>
            <div><label className="field-label">담당자</label><select className="field-select" value={task.assigneeId} onChange={e=>setTask({...task,assigneeId:e.target.value})}><option value="">미지정</option>{detail.members.map(m => <option key={m.userId} value={m.userId}>{m.user.name}</option>)}</select></div>
            <div><label className="field-label">난이도</label><input type="number" min={1} max={5} value={task.difficulty} onChange={e=>setTask({...task,difficulty:Number(e.target.value)})}/></div>
            <div><label className="field-label">예상h</label><input type="number" min={0} step="0.5" value={task.plannedHours} onChange={e=>setTask({...task,plannedHours:e.target.value})}/></div>
            <div><label className="field-label">기한</label><input type="date" value={task.dueDate} onChange={e=>setTask({...task,dueDate:e.target.value})}/></div>
            <button type="button" onClick={addTask} disabled={!task.title.trim()}>Task 추가</button>
          </div>
        </>}
      </div>
    </div>
    </>}
  </div>;
}
