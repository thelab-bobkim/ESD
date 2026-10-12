import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * 2026-10-08: 프로젝트에 연결되지 않은 공수를 고객사별로 모아 보여주고, 한 번의 클릭으로 연결하는 관리자 패널.
 * 직원 입력은 자동으로 프로젝트에 붙지만, 예전 자유입력처럼 이름이 맞지 않아 빠진 공수가 여기에 남는다.
 * 식사/교육 등 제외 작업유형과 본사·SAMPLE 같은 내부업무는 보여주지 않는다. 시스템/인사 관리자만 사용한다.
 */
type Group = {
  key: string; names: string[]; logCount: number; minutes: number; lastDate: string | null;
  registeredClient: { id: string; name: string } | null;
  suggestedProject: { id: string; code: string; name: string } | null;
};
type Unlinked = { totalGroups: number; totalLogs: number; groups: Group[] };
type ProjectLite = { id: string; code: string; name: string };

function hours(minutes: number) { return `${(minutes / 60).toFixed(1)}h`; }

export default function ProjectUnlinkedPanel({ projects, onChanged }: { projects: ProjectLite[]; onChanged: () => void }) {
  const [data, setData] = useState<Unlinked | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [onlyWithHours, setOnlyWithHours] = useState(false);

  async function load() {
    try {
      setError('');
      setData(await apiFetch<Unlinked>('/projects/unlinked'));
    } catch (e) {
      // 팀장 권한 등 사용 권한이 없으면(서버 FORBIDDEN) 패널 자체를 숨긴다.
      if ((e as Error & { code?: string })?.code === 'FORBIDDEN') setForbidden(true);
      else setError(e instanceof Error ? e.message : '연결되지 않은 공수를 불러오지 못했습니다.');
    }
  }
  useEffect(() => { load(); }, []);

  async function assign(g: Group, mode: 'existing' | 'create') {
    const projectId = picked[g.key] ?? g.suggestedProject?.id ?? '';
    const name = (newName[g.key] ?? g.registeredClient?.name ?? g.names[0]).trim();
    if (mode === 'existing' && !projectId) { setError('연결할 프로젝트를 선택하세요.'); return; }
    if (mode === 'create' && name.length < 2) { setError('새 프로젝트 이름을 2자 이상 입력하세요.'); return; }
    const label = mode === 'existing' ? '선택한 프로젝트' : `새 프로젝트 "${name}"`;
    if (!window.confirm(`"${g.names.join(', ')}" 공수 ${g.logCount}건을 ${label}에 연결합니다. 이미 연결된 공수는 바뀌지 않습니다. 진행할까요?`)) return;
    setBusyKey(g.key); setError(''); setNotice('');
    try {
      const body = mode === 'existing'
        ? { names: g.names, projectId }
        : { names: g.names, create: { name, clientId: g.registeredClient?.id ?? null } };
      const r = await apiFetch<{ projectId: string; createdCode: string | null; linked: number; addedMembers: number }>('/projects/unlinked/assign', { method: 'POST', body: JSON.stringify(body) });
      setNotice(`${r.linked}건을 연결했습니다.${r.createdCode ? ` 새 프로젝트 ${r.createdCode}가 만들어졌습니다.` : ''}`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결하지 못했습니다.');
    } finally { setBusyKey(''); }
  }

  if (forbidden) return null;
  const needle = q.trim().toLowerCase();
  const allGroups = data?.groups ?? [];
  const hiddenZero = allGroups.filter((g) => g.minutes <= 0).length;
  const visible = allGroups.filter((g) => (!onlyWithHours || g.minutes > 0) && (!needle || g.names.some((n) => n.toLowerCase().includes(needle))));
  const total = data?.totalLogs ?? 0;
  return <div className="card" style={{ marginBottom: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ margin: 0 }}>연결되지 않은 공수 {data ? `(${data.totalGroups}곳 · ${total}건)` : ''}</h2>
        <small style={{ color: '#6b7280' }}>예전 자유입력 등으로 프로젝트에 붙지 못한 공수입니다. 한 번 연결하면 프로젝트 화면에 바로 반영됩니다.</small>
      </div>
      <button type="button" className="secondary" style={{ width: 'auto' }} onClick={() => setOpen((v) => !v)}>{open ? '접기' : '열기'}</button>
    </div>
    {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    {notice && <p style={{ color: '#047857', margin: '8px 0 0' }}>{notice}</p>}
    {open && data && (data.groups.length === 0 ? <p>연결되지 않은 공수가 없습니다.</p> : <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
        <input style={{ flex: '1 1 220px', minWidth: 0, boxSizing: 'border-box' }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="고객사 이름 검색" />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, whiteSpace: 'nowrap' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={onlyWithHours} onChange={(e) => setOnlyWithHours(e.target.checked)} />
          공수 시간이 있는 곳만 보기{onlyWithHours && hiddenZero > 0 ? ` (시간 0h ${hiddenZero}곳 숨김)` : ''}
        </label>
      </div>
      {visible.length === 0 && <p>조건에 맞는 곳이 없습니다.</p>}
      {visible.map((g) => {
        const projectId = picked[g.key] ?? g.suggestedProject?.id ?? '';
        const busy = busyKey === g.key;
        return <div key={g.key} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ wordBreak: 'break-all' }}>{g.names.join(' / ')}{!g.registeredClient && <span title="등록된 고객사와 이름이 일치하지 않습니다" style={{ marginLeft: 4 }}>⚠</span>}</b>
            <span style={{ fontSize: 13, color: '#6b7280' }}>{g.logCount}건 · {hours(g.minutes)} · 최근 {g.lastDate ?? '-'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            <select className="field-select" style={{ margin: 0, flex: '1 1 240px', minWidth: 0 }} value={projectId} onChange={(e) => setPicked({ ...picked, [g.key]: e.target.value })}>
              <option value="">프로젝트 선택{g.suggestedProject ? '' : ' (제안 없음)'}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </select>
            <button type="button" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={busy || !projectId} onClick={() => assign(g, 'existing')}>{busy ? '처리 중...' : '이 프로젝트에 연결'}</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <input style={{ margin: 0, flex: '1 1 240px', minWidth: 0, boxSizing: 'border-box' }} value={newName[g.key] ?? ''} onChange={(e) => setNewName({ ...newName, [g.key]: e.target.value })} placeholder={`새 프로젝트명 (비우면 "${g.registeredClient?.name ?? g.names[0]}")`} />
            <button type="button" className="secondary" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={busy} onClick={() => assign(g, 'create')}>새로 만들어 연결</button>
          </div>
        </div>;
      })}
      {data.totalGroups > data.groups.length && <p style={{ color: '#6b7280' }}>최근 작업일 기준 상위 {data.groups.length}곳만 표시합니다. 연결하면 다음 곳이 나타납니다.</p>}
    </>)}
  </div>;
}
