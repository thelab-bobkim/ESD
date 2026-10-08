import { useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * 2026-10-08: 프로젝트 상세 안의 "요약 / 공수 이력 / 업무일지" 탭.
 * 메뉴를 늘리지 않고 한 화면에서 이 프로젝트에 쌓인 공수와 업무일지를 볼 수 있게 한다. (조회 전용)
 */
type Summary = {
  totalMinutes: number; totalLogs: number; lastActivityDate: string | null; thisMonthMinutes: number;
  byEngineer: { userId: string; name: string; minutes: number; logCount: number; lastDate: string | null }[];
  byMonth: { month: string; minutes: number; logCount: number }[];
};
type EffortRow = {
  id: string; workDate: string; userId: string; userName: string; workType: string; clientName: string; taskTitle: string | null;
  startTime: string; endTime: string | null; minutes: number; inProgress: boolean; description: string | null; sourceStatus: string | null;
};
type EffortPage = { page: number; pageSize: number; total: number; totalMinutes: number; rows: EffortRow[] };
type DailyRow = {
  workDate: string; userId: string; userName: string; projectMinutes: number; hasLog: boolean;
  visitedClients: string | null; workContent: string | null; issues: string | null; followUp: string | null;
  tomorrowPlan: string | null; supportRequest: string | null; totalWorkedMinutes: number | null;
};
type DailyPage = { page: number; pageSize: number; total: number; rows: DailyRow[] };

type Tab = 'overview' | 'summary' | 'effort' | 'daily';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '개요(참여자·Task)' },
  { key: 'summary', label: '엔지니어·월별 요약' },
  { key: 'effort', label: '공수 이력' },
  { key: 'daily', label: '업무일지' },
];

function hours(minutes: number | null | undefined) { return `${((minutes ?? 0) / 60).toFixed(1)}h`; }
function hm(iso: string | null) {
  if (!iso) return '진행중';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
}

function qs(params: Record<string, string | number>) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) sp.set(k, String(v)); });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return <div className="toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
    <button type="button" className="secondary" style={{ width: 'auto' }} disabled={page <= 1} onClick={() => onPage(page - 1)}>이전</button>
    <span>{page} / {last} 페이지 (총 {total}건)</span>
    <button type="button" className="secondary" style={{ width: 'auto' }} disabled={page >= last} onClick={() => onPage(page + 1)}>다음</button>
  </div>;
}

function Filters({ members, from, to, userId, onChange }: {
  members: { userId: string; name: string }[]; from: string; to: string; userId: string;
  onChange: (v: { from: string; to: string; userId: string }) => void;
}) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, marginBottom: 8 }}>
    <div><label className="field-label">시작일</label><input type="date" value={from} onChange={(e) => onChange({ from: e.target.value, to, userId })} /></div>
    <div><label className="field-label">종료일</label><input type="date" value={to} onChange={(e) => onChange({ from, to: e.target.value, userId })} /></div>
    <div><label className="field-label">엔지니어</label>
      <select className="field-select" value={userId} onChange={(e) => onChange({ from, to, userId: e.target.value })}>
        <option value="">전체</option>
        {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
      </select>
    </div>
  </div>;
}

export default function ProjectInsightTabs({ projectId, members, overview }: { projectId: string; members: { userId: string; name: string }[]; overview: ReactNode }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filters, setFilters] = useState({ from: '', to: '', userId: '' });
  const [page, setPage] = useState(1);
  const [effort, setEffort] = useState<EffortPage | null>(null);
  const [daily, setDaily] = useState<DailyPage | null>(null);

  // 프로젝트를 바꾸면 모든 조회 상태를 처음으로 되돌린다.
  useEffect(() => {
    setTab('overview'); setSummary(null); setEffort(null); setDaily(null); setFilters({ from: '', to: '', userId: '' }); setPage(1); setError('');
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (tab === 'overview') { setLoading(false); setError(''); return; }
      setLoading(true); setError('');
      try {
        if (tab === 'summary') {
          const s = await apiFetch<Summary>(`/projects/${projectId}/summary`);
          if (!cancelled) setSummary(s);
        } else if (tab === 'effort') {
          const r = await apiFetch<EffortPage>(`/projects/${projectId}/effort${qs({ ...filters, page, pageSize: 30 })}`);
          if (!cancelled) setEffort(r);
        } else {
          const r = await apiFetch<DailyPage>(`/projects/${projectId}/daily-logs${qs({ ...filters, page, pageSize: 15 })}`);
          if (!cancelled) setDaily(r);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '조회하지 못했습니다.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [projectId, tab, filters, page]);

  function changeTab(t: Tab) { setTab(t); setPage(1); }
  function changeFilters(v: { from: string; to: string; userId: string }) { setFilters(v); setPage(1); }

  const maxMonth = Math.max(1, ...(summary?.byMonth ?? []).map((m) => m.minutes));

  return <div style={{ marginTop: 16 }}>
    <div className="toolbar" style={{ marginBottom: 8 }}>
      {TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => changeTab(t.key)}>{t.label}</button>)}
    </div>
    {error && <div className="error">{error}</div>}
    {loading && <p>불러오는 중...</p>}

    {tab === 'overview' && overview}

    {tab === 'summary' && summary && <>
      <div className="stat-row">
        <div className="stat-card"><div className="stat-label">누적 공수</div><div className="stat-value">{hours(summary.totalMinutes)}</div></div>
        <div className="stat-card"><div className="stat-label">공수 기록</div><div className="stat-value">{summary.totalLogs}건</div></div>
        <div className="stat-card"><div className="stat-label">이번 달</div><div className="stat-value">{hours(summary.thisMonthMinutes)}</div></div>
        <div className="stat-card"><div className="stat-label">최근 활동일</div><div className="stat-value" style={{ fontSize: 16 }}>{summary.lastActivityDate ?? '-'}</div></div>
      </div>
      <h3>엔지니어별</h3>
      {summary.byEngineer.length === 0 ? <p>아직 연결된 공수가 없습니다.</p> :
        <div className="table-scroll"><table><thead><tr><th>이름</th><th>공수</th><th>기록</th><th>최근 작업일</th></tr></thead>
          <tbody>{summary.byEngineer.map((e) => <tr key={e.userId}><td>{e.name}</td><td>{hours(e.minutes)}</td><td>{e.logCount}건</td><td>{e.lastDate ?? '-'}</td></tr>)}</tbody></table></div>}
      <h3>월별</h3>
      {summary.byMonth.length === 0 ? <p>아직 연결된 공수가 없습니다.</p> :
        <div className="table-scroll"><table><thead><tr><th>월</th><th>공수</th><th>기록</th><th style={{ width: '40%' }}></th></tr></thead>
          <tbody>{[...summary.byMonth].reverse().map((m) => <tr key={m.month}><td>{m.month}</td><td>{hours(m.minutes)}</td><td>{m.logCount}건</td>
            <td><div style={{ background: '#2563eb', height: 8, borderRadius: 4, width: `${Math.max(2, Math.round((m.minutes / maxMonth) * 100))}%` }} /></td></tr>)}</tbody></table></div>}
    </>}

    {tab === 'effort' && <>
      <Filters members={members} {...filters} onChange={changeFilters} />
      {effort && <>
        <p style={{ margin: '4px 0' }}>조건에 맞는 공수 <b>{effort.total}건</b> · 합계 <b>{hours(effort.totalMinutes)}</b></p>
        {effort.rows.length === 0 ? <p>조건에 맞는 공수 기록이 없습니다.</p> :
          <div className="table-scroll"><table><thead><tr><th>날짜</th><th>엔지니어</th><th>시간</th><th>공수</th><th>작업유형</th><th>Task</th><th>작업내용</th></tr></thead>
            <tbody>{effort.rows.map((r) => <tr key={r.id}>
              <td>{r.workDate}</td><td>{r.userName}</td>
              <td>{hm(r.startTime)}~{r.inProgress ? '진행중' : hm(r.endTime)}</td>
              <td>{r.inProgress ? '-' : hours(r.minutes)}</td>
              <td>{r.workType}</td><td>{r.taskTitle ?? '-'}</td>
              <td style={{ whiteSpace: 'pre-wrap', minWidth: 180 }}>{r.description || '-'}</td>
            </tr>)}</tbody></table></div>}
        <Pager page={effort.page} pageSize={effort.pageSize} total={effort.total} onPage={setPage} />
      </>}
    </>}

    {tab === 'daily' && <>
      <p style={{ margin: '4px 0', color: '#6b7280', fontSize: 13 }}>이 프로젝트에 공수를 등록한 엔지니어의 해당 날짜 일일업무일지입니다. 업무일지는 하루 전체를 쓰는 문서라 다른 고객사 내용이 함께 있을 수 있습니다.</p>
      <Filters members={members} {...filters} onChange={changeFilters} />
      {daily && <>
        {daily.rows.length === 0 ? <p>조건에 맞는 기록이 없습니다.</p> : daily.rows.map((r) => <div key={`${r.userId}|${r.workDate}`} className="card" style={{ marginBottom: 8, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <b>{r.workDate} · {r.userName}</b>
            <span>이 프로젝트 {hours(r.projectMinutes)}{r.totalWorkedMinutes != null ? ` / 당일 근무 ${hours(r.totalWorkedMinutes)}` : ''}</span>
          </div>
          {!r.hasLog ? <p style={{ margin: '6px 0 0', color: '#9ca3af' }}>이 날은 업무일지가 작성되지 않았습니다.</p> : <dl style={{ margin: '6px 0 0' }}>
            {([['방문 고객사', r.visitedClients], ['주요 작업내용', r.workContent], ['이슈/특이사항', r.issues], ['후속조치', r.followUp], ['내일 계획', r.tomorrowPlan], ['지원요청', r.supportRequest]] as [string, string | null][])
              .filter(([, v]) => v && v.trim()).map(([k, v]) => <div key={k} style={{ marginBottom: 4 }}><dt style={{ fontWeight: 600, fontSize: 13 }}>{k}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{v}</dd></div>)}
          </dl>}
        </div>)}
        <Pager page={daily.page} pageSize={daily.pageSize} total={daily.total} onPage={setPage} />
      </>}
    </>}
  </div>;
}
