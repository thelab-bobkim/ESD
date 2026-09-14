import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

// 2026-09-01: 기존 "출퇴근·근로시간·공수" 페이지에서 고객사별 공수 부분만 분리해서 만든 페이지.
// 출퇴근/근로시간은 하루~1년 단위(일/주/월/년)로 보지만, 공수는 계약·재계약 판단에 쓰는 자료라
// 월별/분기별/반기별/년간 네 단위로 보는 게 더 자연스러워서 이 페이지만 별도 기간 단위를 쓴다.
// 2026-09-14: "한주 또는 한달 단위로 엔지니어별 고객사 지원시간을 보고싶다"는 요청 반영 —
// 기존 월/분기/반기/년에 주별(week)을 추가한다. 주 경계는 reports.tsx의 startOfWeek와 동일하게
// 월요일~일요일로 통일.
type EffortPeriod = 'week' | 'month' | 'quarter' | 'halfyear' | 'year';
const EFFORT_PERIOD_LABELS: Record<EffortPeriod, string> = { week: '주별', month: '월별', quarter: '분기별', halfyear: '반기별', year: '년간' };
const WORK_TYPE_OPTIONS = ['정기점검', '신규설치', '장애대응', '미팅', '기타'];
const WORK_TYPE_ICONS: Record<string, string> = { 정기점검: '🔧', 신규설치: '🆕', 장애대응: '🚨', 미팅: '🤝', 기타: '📌' };

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
function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

// 2026-09-14: "고객사별 공수관리가 관리자 입장에서 활용 가능한 데이터로 안 보인다"는 의견 반영.
// 서버는 client → project → byUser(엔지니어별 분(分)) 구조로 이미 내려주고 있어서, 아래 두
// 집계는 화면(프론트)에서 같은 데이터를 다시 묶어 보여주는 것 — 백엔드 변경 없이 바로 반영 가능.

/** 한 고객사 안에서, 프로젝트가 여러 개여도 같은 엔지니어면 시간을 합쳐서 "이 고객사에 엔지니어가
 * 총 몇 시간 투입됐는지" 보여준다(기존엔 프로젝트를 펼쳐야만, 그것도 프로젝트별로 나뉘어 보였음). */
function aggregateClientByEngineer(client: EffortClientRow): EffortByUser[] {
  const map = new Map<string, EffortByUser>();
  for (const project of client.projects) {
    for (const u of project.byUser) {
      const cur = map.get(u.userId);
      if (cur) cur.minutes += u.minutes;
      else map.set(u.userId, { ...u });
    }
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes);
}

interface EngineerClientShare { clientName: string; minutes: number; }
interface EngineerAggRow { userId: string; name: string; totalMinutes: number; clientCount: number; byClient: EngineerClientShare[]; }

/** "엔지니어가 이 기간에 어떤 고객사를 몇 시간씩 지원했는지" — client 기준 데이터를 엔지니어
 * 기준으로 뒤집어서 다시 묶는다. 총 투입시간이 많은 엔지니어부터 보여준다. */
function pivotByEngineer(clients: EffortClientRow[]): EngineerAggRow[] {
  const map = new Map<string, EngineerAggRow>();
  for (const client of clients) {
    for (const u of aggregateClientByEngineer(client)) {
      let row = map.get(u.userId);
      if (!row) {
        row = { userId: u.userId, name: u.name, totalMinutes: 0, clientCount: 0, byClient: [] };
        map.set(u.userId, row);
      }
      row.totalMinutes += u.minutes;
      row.clientCount += 1;
      row.byClient.push({ clientName: client.clientName, minutes: u.minutes });
    }
  }
  for (const row of map.values()) {
    row.byClient.sort((a, b) => b.minutes - a.minutes);
  }
  return [...map.values()].sort((a, b) => b.totalMinutes - a.totalMinutes);
}

// reports.tsx의 startOfWeek와 동일한 규칙(월요일 시작).
function startOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday;
}

// 주/월/분기/반기/년 단위 범위 계산 — reports.tsx의 computeRange(일/주/월/년)와 같은 패턴이되,
// 분기(3개월)·반기(6개월) 구간을 새로 추가했다.
function computeEffortRange(period: EffortPeriod, anchor: Date): { from: Date; to: Date; label: string } {
  const y = anchor.getFullYear();
  if (period === 'week') {
    const from = startOfWeek(anchor);
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    return { from, to, label: `${fmt(from)} ~ ${fmt(to)}` };
  }
  if (period === 'month') {
    const from = new Date(y, anchor.getMonth(), 1);
    const to = new Date(y, anchor.getMonth() + 1, 0);
    return { from, to, label: `${y}년 ${anchor.getMonth() + 1}월` };
  }
  if (period === 'quarter') {
    const q = Math.floor(anchor.getMonth() / 3); // 0~3
    const from = new Date(y, q * 3, 1);
    const to = new Date(y, q * 3 + 3, 0);
    return { from, to, label: `${y}년 ${q + 1}분기` };
  }
  if (period === 'halfyear') {
    const h = Math.floor(anchor.getMonth() / 6); // 0~1
    const from = new Date(y, h * 6, 1);
    const to = new Date(y, h * 6 + 6, 0);
    return { from, to, label: `${y}년 ${h === 0 ? '상반기' : '하반기'}` };
  }
  const from = new Date(y, 0, 1);
  const to = new Date(y, 11, 31);
  return { from, to, label: `${y}년` };
}

function shiftEffortAnchor(period: EffortPeriod, anchor: Date, dir: 1 | -1): Date {
  const d = new Date(anchor);
  if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else if (period === 'month') d.setMonth(d.getMonth() + dir);
  else if (period === 'quarter') d.setMonth(d.getMonth() + dir * 3);
  else if (period === 'halfyear') d.setMonth(d.getMonth() + dir * 6);
  else d.setFullYear(d.getFullYear() + dir);
  return d;
}

export default function AdminEffortPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<EffortPeriod>('month');
  const [anchor, setAnchor] = useState(new Date());
  const [effort, setEffort] = useState<EffortSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [expandedEngineers, setExpandedEngineers] = useState<Record<string, boolean>>({});
  // 2026-09-14: "고객별 어떤 엔지니어가 몇시간 지원했는지"는 기존 고객사별 보기(엔지니어별 요약을
  // 추가), "엔지니어가 한주/한달에 어떤 고객사를 몇시간 지원했는지"는 이 엔지니어별 보기로 각각 대응.
  const [viewMode, setViewMode] = useState<'client' | 'engineer'>('client');
  const [workTypeFilter, setWorkTypeFilter] = useState('ALL');
  // 년/월/일을 직접 선택하는 기간 — 지정하면 위 탭(월/분기/반기/년)보다 우선한다.
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const tabRange = useMemo(() => computeEffortRange(period, anchor), [period, anchor]);
  const isCustom = Boolean(customFrom && customTo);
  const effectiveFrom = isCustom ? customFrom : fmt(tabRange.from);
  const effectiveTo = isCustom ? customTo : fmt(tabRange.to);
  const rangeLabel = isCustom ? `${customFrom} ~ ${customTo}(직접 선택)` : tabRange.label;

  useEffect(() => {
    setError(null);
    apiFetch<EffortSummary>(`/reports/effort-summary?from=${effectiveFrom}&to=${effectiveTo}&workType=${workTypeFilter}`)
      .then(setEffort)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFrom, effectiveTo, workTypeFilter]);

  function toggleProject(key: string) {
    setExpandedProjects((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleEngineer(userId: string) {
    setExpandedEngineers((prev) => ({ ...prev, [userId]: !prev[userId] }));
  }

  function selectTab(p: EffortPeriod) {
    setCustomFrom('');
    setCustomTo('');
    setPeriod(p);
  }

  const effortTotalMinutes = useMemo(() => (effort ? effort.clients.reduce((s, c) => s + c.totalMinutes, 0) : 0), [effort]);
  const engineerRows = useMemo(() => (effort ? pivotByEngineer(effort.clients) : []), [effort]);

  return (
    <div className="admin-shell">
      <AdminHeader title="고객사별 공수관리" />
      <p className="admin-page-subtitle">고객사별 투입 공수를 월별·분기별·반기별·년간 단위로 확인하고 내려받으세요.</p>
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        {(Object.keys(EFFORT_PERIOD_LABELS) as EffortPeriod[]).map((p) => (
          <button key={p} className={period === p && !isCustom ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => selectTab(p)}>
            {EFFORT_PERIOD_LABELS[p]}
          </button>
        ))}
        <div className="spacer" />
        <button className="secondary" style={{ width: 'auto' }} disabled={isCustom} onClick={() => setAnchor(shiftEffortAnchor(period, anchor, -1))}>‹ 이전</button>
        <span style={{ fontWeight: 700, minWidth: 160, textAlign: 'center' }}>{rangeLabel}</span>
        <button className="secondary" style={{ width: 'auto' }} disabled={isCustom} onClick={() => setAnchor(shiftEffortAnchor(period, anchor, 1))}>다음 ›</button>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => { setCustomFrom(''); setCustomTo(''); setAnchor(new Date()); }}>이번 달</button>
      </div>

      {/* 년/월/일을 직접 선택하는 기간 */}
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

      {/* 고객사별 공수 현황 — 관리 판단 기준(총 투입시간/편중도/증감/주요유형) 중심으로 구성 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2>🛠️ 공수(工數) 현황 — {rangeLabel}</h2>
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

        {/* 2026-09-14: "고객별 어떤 엔지니어가 몇시간 지원했는지" ↔ "엔지니어가 어떤 고객사를
            몇시간 지원했는지" — 같은 데이터를 보는 관점이 다를 뿐이라 탭으로 전환할 수 있게 했다. */}
        <div className="toolbar" style={{ marginTop: 4, marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: '#495057' }}>보기:</span>
          <button className={viewMode === 'client' ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => setViewMode('client')}>
            🏢 고객사별
          </button>
          <button className={viewMode === 'engineer' ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => setViewMode('engineer')}>
            🧑‍💻 엔지니어별
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#868e96', marginTop: 4, marginBottom: 12 }}>
          {viewMode === 'client'
            ? '고객사별 총 투입시간과 엔지니어별 분담 현황입니다. 직전 동일기간 대비 증감률, 엔지니어 편중도(한 명이 몇 %를 담당하는지)도 함께 보여드려서 재계약·리스크 판단에 참고하실 수 있습니다.'
            : '엔지니어별로 이 기간에 어떤 고객사를 몇 시간씩 지원했는지 보여드립니다. 투입시간이 많은 엔지니어부터 정렬됩니다.'}
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

        {effort && effort.clients.length > 0 && viewMode === 'engineer' && engineerRows.map((eng) => {
          const isEngExpanded = expandedEngineers[eng.userId] ?? false;
          return (
            <div key={eng.userId} className="board-column" style={{ marginBottom: 10, borderTopColor: '#2f6feb' }}>
              <div className="board-column-header" style={{ cursor: 'pointer' }} onClick={() => toggleEngineer(eng.userId)}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, transform: isEngExpanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                  {' '}🧑‍💻 {eng.name}
                  <span style={{ color: '#868e96', fontWeight: 400 }}> · 고객사 {eng.clientCount}개</span>
                </span>
                <span className="count">{hoursLabel(eng.totalMinutes)}</span>
              </div>
              {isEngExpanded && (
                <div style={{ padding: '4px 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {eng.byClient.map((c) => (
                    <div key={c.clientName} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f1f3f5' }}>
                      <span>🏢 {c.clientName}</span>
                      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{hoursLabel(c.minutes)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {effort && viewMode === 'client' && effort.clients.map((client) => {
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

              {/* 2026-09-14: "고객별로 어떤 엔지니어가 몇시간 지원했는지"를 프로젝트를 펼치지 않아도
                  바로 볼 수 있게 — 프로젝트가 여러 개여도 엔지니어별로 시간을 합쳐서 보여준다. */}
              <div style={{ padding: '0 14px 10px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {aggregateClientByEngineer(client).map((u) => (
                  <span key={u.userId} className="employee-chip" style={{ margin: 0, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                    <span style={{ fontWeight: 600 }}>{u.name}</span>
                    <span style={{ color: '#868e96', fontVariantNumeric: 'tabular-nums' }}>{hoursLabel(u.minutes)}</span>
                  </span>
                ))}
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
                    {/* 2026-09-02: 이름 표시 순서를 다른 화면과 통일 — 가나다순. */}
                    {isProjectExpanded && [...row.byUser].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((u) => (
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
    </div>
  );
}
