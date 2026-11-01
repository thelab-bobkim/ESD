import { Fragment, useEffect, useState } from 'react';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

type Engineer = { userId: string; name: string; minutes: number; pct: number };
type Recent = { workDate: string; userName: string; minutes: number; workType: string; description: string };
type Site = {
  rank: number; id: string; code: string; name: string; status: string; client: string | null;
  manager: { id: string; name: string } | null; minutes: number; sharePct: number;
  engineerCount: number; engineers: Engineer[]; monthly: { month: string; minutes: number }[];
  recent: Recent[]; lastActivityDate: string | null;
};
type Data = { from: string; to: string; totalMinutes: number; items: Site[] };
type UserOpt = { id: string; name: string; department: string };

// 2026-11-01: 프로젝트관리 "핵심 사이트 TOP 30" — 기간 내 실공수가 가장 많은 사이트(프로젝트) 순위.
const hours = (m: number) => `${(m / 60).toFixed(1)}h`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const PERIODS = [
  { key: '30', label: '최근 30일' },
  { key: '90', label: '최근 3개월' },
  { key: 'year', label: '올해' },
  { key: 'all', label: '전체' },
];

function range(key: string) {
  const now = new Date();
  if (key === 'all') return { from: '2000-01-01', to: ymd(now) };
  if (key === 'year') return { from: `${now.getFullYear()}-01-01`, to: ymd(now) };
  const days = key === '30' ? 30 : 90;
  return { from: ymd(new Date(now.getTime() - days * 86400000)), to: ymd(now) };
}

export default function CoreSitesPanel({ users, onAuthExpired }: { users: UserOpt[]; onAuthExpired: () => void }) {
  const [period, setPeriod] = useState('90');
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function load(key: string) {
    try {
      const r = range(key);
      setData(await apiFetch<Data>(`/projects/core-sites?from=${r.from}&to=${r.to}&limit=30`));
      setError('');
    } catch (e) {
      if (isAuthExpiredError(e)) { onAuthExpired(); return; }
      setError(e instanceof Error ? e.message : '핵심 사이트를 불러오지 못했어요.');
    }
  }
  useEffect(() => { load(period); }, [period]);

  async function setManager(projectId: string, managerId: string) {
    try {
      const body = JSON.stringify({ managerId: managerId || null });
      await apiFetch(`/projects/${projectId}`, { method: 'PATCH', body });
      await load(period);
    } catch (e) {
      setError(e instanceof Error ? e.message : '담당 PM을 지정하지 못했어요.');
    }
  }

  const top = data?.items ?? [];
  const topMin = top.reduce((s, x) => s + x.minutes, 0);
  const topPct = data && data.totalMinutes > 0 ? Math.round((topMin * 100) / data.totalMinutes) : 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🏆 핵심 사이트 TOP 30 (실공수 기준)</h2>
        <select
          className="field-select"
          style={{ margin: 0, width: 'auto' }}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <p style={{ fontSize: 13, color: '#64748b' }}>
          {data.from} ~ {data.to} · 전체 {hours(data.totalMinutes)} 중 상위 {top.length}개가 {hours(topMin)} ({topPct}%)
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>순위</th><th>사이트</th><th>실공수</th><th>비중</th><th>투입</th><th>최근 지원</th><th>담당 PM</th><th></th></tr>
          </thead>
          <tbody>
            {top.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td>{s.rank}</td>
                  <td>
                    {s.code} · {s.name}
                    {s.client ? <div style={{ fontSize: 12, color: '#64748b' }}>{s.client}</div> : null}
                  </td>
                  <td><strong>{hours(s.minutes)}</strong></td>
                  <td>{s.sharePct}%</td>
                  <td>{s.engineerCount}명{s.engineers[0] ? ` (주: ${s.engineers[0].name} ${s.engineers[0].pct}%)` : ''}</td>
                  <td>{s.lastActivityDate ?? '-'}</td>
                  <td>
                    <select
                      className="field-select"
                      style={{ margin: 0, minWidth: 110 }}
                      value={s.manager?.id ?? ''}
                      onChange={(e) => setManager(s.id, e.target.value)}
                    >
                      <option value="">미지정</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      style={{ width: 'auto', margin: 0 }}
                      onClick={() => setOpen(open === s.id ? null : s.id)}
                    >
                      {open === s.id ? '접기' : '상세'}
                    </button>
                  </td>
                </tr>
                {open === s.id && (
                  <tr>
                    <td colSpan={8}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 16 }}>
                        <div>
                          <strong>월별 추이</strong>
                          {s.monthly.map((m) => (
                            <div key={m.month} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                              <span style={{ width: 62 }}>{m.month}</span>
                              <div style={{ background: '#3b82f6', height: 10, borderRadius: 5, width: barPct(m.minutes, s.monthly) }} />
                              <span>{hours(m.minutes)}</span>
                            </div>
                          ))}
                        </div>
                        <div>
                          <strong>투입 엔지니어</strong>
                          {s.engineers.map((e) => (
                            <div key={e.userId} style={{ fontSize: 13 }}>{e.name} · {hours(e.minutes)} ({e.pct}%)</div>
                          ))}
                        </div>
                        <div>
                          <strong>최근 지원 내역</strong>
                          {s.recent.map((r, i) => (
                            <div key={i} style={{ fontSize: 13 }}>
                              {r.workDate} · {r.userName} · {hours(r.minutes)}{r.description ? ` · ${r.description}` : ''}
                            </div>
                          ))}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {data && top.length === 0 && <p>이 기간에 프로젝트에 연결된 공수 기록이 없어요.</p>}
    </div>
  );
}

function barPct(v: number, all: { minutes: number }[]) {
  const mx = Math.max(...all.map((x) => x.minutes), 1);
  return `${Math.round((v / mx) * 100)}%`;
}
