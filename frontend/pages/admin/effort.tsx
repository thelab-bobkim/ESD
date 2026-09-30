import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload } from '@/lib/api';
import { sortByLabelKo } from '@/lib/sortKo';
import { classifyDeptGroup } from '@/lib/deptGroup';
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
// 2026-09-14(2차): "고객사별 공수관리가 관리자 입장에서 활용 가능한 데이터로 안 보인다"는 의견을
// 받아, 프로젝트·엔지니어 단위로 이미 합산된 목록을 쭉 펼치는 대신 관점(고객사별/엔지니어별)과
// 대상을 드롭다운으로 고르고, 그 대상이 실제로 한 일을 시계열로 보여주는 방식으로 화면을 바꿨다
// (시안 두 가지 중 로그형 타임라인을 선택받음). 작업유형별 아이콘/색상을 여기서 한 번에 관리한다.
const TYPE_META: Record<string, { icon: string; color: string; soft: string }> = {
  정기점검: { icon: '🔧', color: '#0c8599', soft: '#e6fcf5' },
  신규설치: { icon: '🆕', color: '#3d5afe', soft: '#eef1ff' },
  장애대응: { icon: '🚨', color: '#e03131', soft: '#fff0f0' },
  미팅: { icon: '🤝', color: '#6741d9', soft: '#f2effc' },
  기타: { icon: '📌', color: '#626a7d', soft: '#f1f3f5' },
};
const WORK_TYPE_ICONS: Record<string, string> = Object.fromEntries(Object.entries(TYPE_META).map(([k, v]) => [k, v.icon]));

// 2026-09-14: "엔지니어별" 관점은 실제 기술부 소속만 대상으로 한다는 요청 반영 — 어떤 부서
// 소속인지 판별하려면 department가 필요해서 백엔드가 이제 함께 내려준다(reports.routes.ts 참고).
interface EffortByUser { userId: string; name: string; department: string; minutes: number; }
interface EffortProjectRow { projectName: string; clientName: string; totalMinutes: number; workTypes: string[]; byUser: EffortByUser[]; }
interface EffortClientRow {
  clientName: string; totalMinutes: number; projectCount: number; engineerCount: number;
  topEngineerName: string | null; concentrationPct: number; topWorkType: string | null; trendPct: number | null;
  projects: EffortProjectRow[];
}
interface EffortSummary { from: string; to: string; clients: EffortClientRow[]; }

interface TimelineEntry {
  id: string; workDate: string; day: string; clientName: string; projectName: string; workType: string;
  startLabel: string; endLabel: string | null; minutes: number; actualMinutes: number; description: string; userId: string; userName: string;
}
interface TimelineResponse { from: string; to: string; scope: 'client' | 'engineer'; value: string; entries: TimelineEntry[]; }

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

// 서버는 client → project → byUser(엔지니어별 분(分)) 구조로 이미 내려주고 있어서, 아래 두
// 집계는 화면(프론트)에서 같은 데이터를 다시 묶어 대상(드롭다운) 목록과 시간을 만드는 것 —
// 백엔드 변경 없이 바로 반영 가능.

/** 한 고객사 안에서, 프로젝트가 여러 개여도 같은 엔지니어면 시간을 합쳐서 "이 고객사에 엔지니어가
 * 총 몇 시간 투입됐는지" 보여준다. */
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

interface EngineerAggRow { userId: string; name: string; department: string; totalMinutes: number; }

/** "엔지니어별 대상 목록" — client 기준 데이터를 엔지니어 기준으로 뒤집어서 총 투입시간을 구한다.
 * 드롭다운에 보여줄 최종 순서(이름 가나다순)와 기술부 필터는 engineerTargets에서 처리한다. */
function pivotByEngineer(clients: EffortClientRow[]): EngineerAggRow[] {
  const map = new Map<string, EngineerAggRow>();
  for (const client of clients) {
    for (const u of aggregateClientByEngineer(client)) {
      const row = map.get(u.userId) ?? { userId: u.userId, name: u.name, department: u.department, totalMinutes: 0 };
      row.totalMinutes += u.minutes;
      map.set(u.userId, row);
    }
  }
  return [...map.values()];
}

/** 대상(고객사 또는 엔지니어)이 이 기간에 실제로 수행한 개별 공수기록을, 날짜별로 묶는다.
 *
 * 2026-09-18: "실 공수시간 자동 산정" 반영 — 배지(durLabel)와 날짜별 합계(totalLabel)는 원본
 * 등록시간(minutes)이 아니라 점심시간 실제 겹침이 빠진 실공수시간(actualMinutes)을 기준으로
 * 보여준다(공수비용 산정 등 실제 업무에 쓰이는 값과 화면을 일치시킴). 다만 옆에 보이는
 * 시작~종료 시각은 원본 그대로이므로, 둘이 달라 보여 헷갈리지 않도록 차감된 경우에만
 * "(점심 N분 차감)" 표시를 함께 준다. */
function groupTimeline(entries: TimelineEntry[]) {
  const byDate = new Map<string, TimelineEntry[]>();
  for (const e of entries) {
    const arr = byDate.get(e.workDate);
    if (arr) arr.push(e);
    else byDate.set(e.workDate, [e]);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([workDate, es]) => {
      const total = es.reduce((s, e) => s + e.actualMinutes, 0);
      const [, mo, d] = workDate.split('-');
      return {
        workDate,
        dateLabel: `${Number(mo)}월 ${Number(d)}일 (${es[0].day})`,
        totalLabel: hoursLabel(total),
        entries: es.map((e) => {
          const lunchDeducted = Math.max(0, e.minutes - e.actualMinutes);
          return { ...e, durLabel: hoursLabel(e.actualMinutes), lunchDeducted };
        }),
      };
    });
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
  // 2026-09-14(2차): 관점(고객사별/엔지니어별)과 대상을 드롭다운으로 고르면, 그 대상 하나의
  // 시계열 타임라인만 아래에 자세히 보여준다 — 예전처럼 전체 목록을 쭉 펼쳐두지 않는다.
  const [perspective, setPerspective] = useState<'client' | 'engineer'>('client');
  const [selectedClientName, setSelectedClientName] = useState('');
  const [selectedEngineerId, setSelectedEngineerId] = useState('');
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [workTypeFilter, setWorkTypeFilter] = useState('ALL');
  // 년/월/일을 직접 선택하는 기간 — 지정하면 위 탭(월/분기/반기/년)보다 우선한다.
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // 2026-09-14: "엔지니어별" 대상 목록은 이 기간에 공수기록이 있는 사람만이 아니라, 출퇴근·근로시간
  // 화면의 "기술부만 보기"에 나오는 인원 전체(기록이 아직 없어도)를 항상 보여줘야 한다는 요청 —
  // 기간과 무관한 재직중 전 직원 명단을 한 번만 불러와서(roster) 기술부만 걸러 쓴다.
  const [roster, setRoster] = useState<{ userId: string; name: string; department: string }[] | null>(null);
  useEffect(() => {
    apiFetch<{ userId: string; name: string; department: string }[]>('/reports/employee-roster')
      .then(setRoster)
      .catch(() => setRoster([]));
  }, []);

  const tabRange = useMemo(() => computeEffortRange(period, anchor), [period, anchor]);
  const isCustom = Boolean(customFrom && customTo);
  const effectiveFrom = isCustom ? customFrom : fmt(tabRange.from);
  const effectiveTo = isCustom ? customTo : fmt(tabRange.to);
  const rangeLabel = isCustom ? `${customFrom} ~ ${customTo}(직접 선택)` : tabRange.label;

  // 2026-09-30 수정: 기간 탭을 빠르게 전환하면 겹친 요청 중 더 이전 응답이 나중에 도착해 화면에
  // 표시된 기간과 다른 데이터로 덮어쓸 수 있었다 — 요청 번호 가드로 최신 요청의 응답만 반영한다.
  const summaryRequestRef = useRef(0);
  useEffect(() => {
    const requestId = ++summaryRequestRef.current;
    setError(null);
    apiFetch<EffortSummary>(`/reports/effort-summary?from=${effectiveFrom}&to=${effectiveTo}&workType=${workTypeFilter}`)
      .then((data) => { if (summaryRequestRef.current === requestId) setEffort(data); })
      .catch((err) => {
        if (summaryRequestRef.current !== requestId) return;
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFrom, effectiveTo, workTypeFilter]);

  function selectTab(p: EffortPeriod) {
    setCustomFrom('');
    setCustomTo('');
    setPeriod(p);
  }

  // 2026-09-14: 대상 드롭다운은 투입시간 순이 아니라 항상 이름 가나다순(오름차순)으로 고정한다 —
  // 대상이 많아질수록 시간순으로는 원하는 이름을 찾기 어렵다는 요청(sortByLabelKo 참고).
  const clientTargets = useMemo(
    () =>
      effort
        ? sortByLabelKo(
            effort.clients.map((c) => ({ key: c.clientName, label: c.clientName, totalMinutes: c.totalMinutes })),
            (t) => t.label
          )
        : [],
    [effort]
  );
  // 2026-09-14: "엔지니어별" 관점은 출퇴근·근로시간 화면에서 정의한 영업부/기술부 분류 기준과
  // 동일하게(classifyDeptGroup) 실제 기술부 소속만 "엔지니어"로 취급하고, "기술부만 보기"와
  // 동일하게 이 기간에 공수기록이 없는 사람도 빠짐없이 보여준다(투입시간 0으로 표시) — 기록
  // 기준이 아니라 재직중 인원(roster) 기준으로 목록을 만들고, 그 위에 이 기간의 투입시간을 얹는다.
  const engineerTargets = useMemo(() => {
    if (!roster) return [];
    const minutesByUser = new Map(pivotByEngineer(effort?.clients ?? []).map((e) => [e.userId, e.totalMinutes]));
    const techEmployees = roster.filter((r) => classifyDeptGroup(r.department) === 'tech');
    return sortByLabelKo(
      techEmployees.map((r) => ({ key: r.userId, label: r.name, totalMinutes: minutesByUser.get(r.userId) ?? 0 })),
      (t) => t.label
    );
  }, [roster, effort]);
  const currentTargets = perspective === 'client' ? clientTargets : engineerTargets;
  // 선택된 대상이 이번 기간엔 없으면(예: 기간을 바꿔서 그 고객사/엔지니어의 기록이 없어짐) 목록의
  // 첫 항목으로 자연스럽게 넘어간다 — 빈 드롭다운이 뜨는 걸 막는다.
  const selectedKey = perspective === 'client' ? selectedClientName : selectedEngineerId;
  const resolvedKey = currentTargets.some((t) => t.key === selectedKey) ? selectedKey : (currentTargets[0]?.key ?? '');
  const currentTarget = currentTargets.find((t) => t.key === resolvedKey) ?? null;
  // 고객사별 관점은 effort 응답만 있으면 되지만, 엔지니어별 관점은 roster까지 로드돼야 목록이
  // 완성된다(engineerTargets 참고).
  const isDataLoading = !effort || (perspective === 'engineer' && !roster);

  const timelineRequestRef = useRef(0);
  useEffect(() => {
    const requestId = ++timelineRequestRef.current;
    if (!resolvedKey) {
      setTimeline(null);
      return;
    }
    setTimelineError(null);
    apiFetch<TimelineResponse>(
      `/reports/effort-timeline?from=${effectiveFrom}&to=${effectiveTo}&workType=${workTypeFilter}&scope=${perspective}&value=${encodeURIComponent(resolvedKey)}`
    )
      .then((res) => { if (timelineRequestRef.current === requestId) setTimeline(res.entries); })
      .catch((err) => {
        if (timelineRequestRef.current !== requestId) return;
        setTimelineError(err instanceof Error ? err.message : '타임라인을 불러오지 못했습니다.');
      });
  }, [perspective, resolvedKey, effectiveFrom, effectiveTo, workTypeFilter]);

  const timelineGroups = useMemo(() => (timeline ? groupTimeline(timeline) : []), [timeline]);
  // 2026-09-18: 점심시간 실제 겹침을 뺀 실공수시간(actualMinutes) 합계 — 공수비용 산정에 쓰이는
  // 값과 화면 총계를 일치시킨다(원본 등록시간 합계는 CSV 내려받기의 "등록시간(시간)"에서 확인 가능).
  const timelineTotalMinutes = useMemo(() => (timeline ? timeline.reduce((s, e) => s + e.actualMinutes, 0) : 0), [timeline]);
  const counterpartCount = useMemo(
    () => (timeline ? new Set(timeline.map((e) => (perspective === 'client' ? e.userId : e.clientName))).size : 0),
    [timeline, perspective]
  );
  const counterpartWord = perspective === 'client' ? '참여 엔지니어' : '지원 고객사';
  const counterpartUnit = perspective === 'client' ? '명' : '개';

  return (
    <div className="admin-shell">
      <AdminHeader title="고객사별 공수관리" />
      <p className="admin-page-subtitle">고객사·엔지니어를 골라 이 기간에 어떤 작업을 했는지 시계열로 확인하고 내려받으세요.</p>
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

      {/* 관점(고객사별/엔지니어별) + 대상 드롭다운, 작업유형 필터, CSV 내려받기 */}
      <div className="toolbar">
        <span style={{ fontSize: 13, color: '#495057' }}>관점</span>
        <select
          className="field-select"
          style={{ margin: 0, width: 'auto' }}
          value={perspective}
          onChange={(e) => setPerspective(e.target.value as 'client' | 'engineer')}
        >
          <option value="client">🏢 고객사별</option>
          <option value="engineer">🧑‍💻 엔지니어별</option>
        </select>
        <span style={{ fontSize: 13, color: '#495057' }}>대상</span>
        <select
          className="field-select"
          style={{ margin: 0, width: 'auto', minWidth: 220 }}
          value={resolvedKey}
          onChange={(e) => (perspective === 'client' ? setSelectedClientName(e.target.value) : setSelectedEngineerId(e.target.value))}
        >
          {currentTargets.length === 0 && <option value="">(이 기간에 등록된 기록 없음)</option>}
          {currentTargets.map((t) => (
            <option key={t.key} value={t.key}>{t.label} · {hoursLabel(t.totalMinutes)}</option>
          ))}
        </select>
        <div className="spacer" />
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

      {/* 엔지니어별 관점은 roster(재직중 기술부 명단)까지 로드돼야 목록이 완성되므로, 기간 데이터
          (effort)뿐 아니라 roster도 같이 기다린다. */}
      {isDataLoading && <div className="card"><div className="board-empty">불러오는 중...</div></div>}
      {!isDataLoading && currentTargets.length === 0 && (
        <div className="card"><div className="board-empty">이 조건에 등록된(완료된) 공수기록이 없습니다.</div></div>
      )}

      {!isDataLoading && currentTarget && (
        <>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>
                <span>{perspective === 'client' ? '🏢' : '🧑‍💻'}</span>
                <span>{currentTarget.label}</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#868e96', background: '#f1f3f5', borderRadius: 999, padding: '5px 12px' }}>
                {rangeLabel}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 16 }}>
              <div className="stat-card">
                <div className="stat-label">총 실공수시간</div>
                <div className="stat-value">{hoursLabel(timelineTotalMinutes)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">활동 건수</div>
                <div className="stat-value">{timeline?.length ?? 0}건</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">{counterpartWord}</div>
                <div className="stat-value">{counterpartCount}{counterpartUnit}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>🕒 상세 활동 타임라인</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {WORK_TYPE_OPTIONS.map((t) => (
                <span key={t} style={{ fontSize: 12, fontWeight: 600, borderRadius: 999, padding: '4px 10px', background: TYPE_META[t].soft, color: TYPE_META[t].color }}>
                  {TYPE_META[t].icon} {t}
                </span>
              ))}
            </div>

            {timelineError && <div className="error">{timelineError}</div>}
            {!timeline && !timelineError && <div className="board-empty">불러오는 중...</div>}
            {timeline && timeline.length === 0 && <div className="board-empty">이 기간에 등록된 활동이 없습니다.</div>}

            {timelineGroups.map((g) => (
              <div key={g.workDate} style={{ marginBottom: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8f9fc', padding: '7px 12px', borderRadius: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: '#495057' }}>{g.dateLabel}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#868e96' }}>{g.totalLabel}</span>
                </div>
                {g.entries.map((e) => {
                  const meta = TYPE_META[e.workType] ?? TYPE_META['기타'];
                  return (
                    <div key={e.id} style={{ display: 'flex', gap: 12, padding: '11px 12px', borderBottom: '1px solid #f1f3f5' }}>
                      <div style={{ width: 3, borderRadius: 3, background: meta.color, flexShrink: 0 }} />
                      <div style={{ width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0, background: meta.soft, marginTop: 1 }}>
                        {meta.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13.5 }}>
                          <span style={{ fontWeight: 800 }}>{perspective === 'client' ? e.userName : `🏢 ${e.clientName}`}</span>
                          <span style={{ fontSize: 12, color: '#868e96', fontVariantNumeric: 'tabular-nums' }}>
                            {e.workType} · {e.startLabel} ~ {e.endLabel ?? '진행중'}
                            {e.lunchDeducted > 0 && (
                              <span style={{ color: '#f08c00', fontWeight: 600 }}> (점심 {e.lunchDeducted}분 차감)</span>
                            )}
                          </span>
                          <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px', background: meta.soft, color: meta.color }}>
                            {e.durLabel}
                          </span>
                        </div>
                        {e.description && (
                          <div style={{ fontSize: 12.5, color: '#868e96', lineHeight: 1.6, marginTop: 4 }}>{e.description}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
