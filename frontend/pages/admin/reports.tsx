import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

const WEEKLY_LIMIT_MINUTES = 52 * 60; // 주52시간제 기준
type Period = 'day' | 'week' | 'month' | 'year';
const PERIOD_LABELS: Record<Period, string> = { day: '일', week: '주', month: '월', year: '년' };
// 타임라인에 표시할 상태별 아이콘/라벨/색상 (직원화면 STATUS_META와 동일한 코드 목록)
const TIMELINE_STATUS_META: Record<string, { label: string; icon: string; color: string }> = {
  REMOTE: { label: '재택(집)', icon: '🏠', color: '#6741d9' },
  HQ_WORKING: { label: '본사근무', icon: '🏢', color: '#2f9e44' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬', color: '#2f9e44' },
  OFFSITE: { label: '외근', icon: '🚗', color: '#1c7ed6' },
  MOVING: { label: '이동중', icon: '🚙', color: '#1c7ed6' },
  MEETING: { label: '회의중', icon: '👥', color: '#1c7ed6' },
  CLIENT_MEETING: { label: '고객사미팅', icon: '🤝', color: '#1c7ed6' },
  CLIENT_WORK: { label: '고객사작업', icon: '🛠️', color: '#1c7ed6' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙', color: '#f08c00' },
  BUSINESS_TRIP: { label: '출장', icon: '✈️', color: '#1c7ed6' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
};

interface WorktimeRow {
  userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number;
}
interface WorktimeSummary { from: string; to: string; rows: WorktimeRow[]; }

interface AttendanceDetailRow {
  recordId: string; userId: string; employeeNo: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; clockOutLocation: string | null; totalWorkedMinutes: number | null;
  isCorrected: boolean; correctionReason: string | null;
}
interface AttendanceDetail { date: string; rows: AttendanceDetailRow[]; }

interface TimelineEntry { status: string; changedAt: string; note: string | null; durationMinutes: number; ongoing: boolean; }
interface DailyTimeline {
  date: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; clockOutLocation: string | null; totalWorkedMinutes: number | null;
  timeline: TimelineEntry[];
}

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
/** <input type="datetime-local">에 넣을 값 (YYYY-MM-DDTHH:MM, 로컬시간 기준) */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

// 하루의 경계는 자정이 아니라 새벽 3시(KST) — backend attendance-helpers.ts의 todayDateOnly()와
// 동일한 규칙. "진행중"이 오늘(정상)인지 지난 근무일(미해결 문제)인지 구분하는 데 쓴다.
function todayWorkDateKST(): string {
  const now = new Date();
  const kstShifted = new Date(now.getTime() + (9 - 3) * 60 * 60 * 1000);
  const y = kstShifted.getUTCFullYear();
  const mo = String(kstShifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kstShifted.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// 아직 퇴근이 확정 안 된(clockOutAt null) 상태에서, 근무시간 칸에 뭐라도 보여주기 위한 "18시
// 기준 잠정치"만 계산한다 — attendance_records.total_worked_minutes(실제 집계/급여 기준)는
// 절대 여기서 건드리지 않는다. 진짜 값은 여전히 본인 퇴근 버튼 또는 정정신청 승인으로만 채워진다
// (정정신청이 승인되면 approval.routes.ts가 그 시각 기준으로 자동 반영한다).
function tentativeMinutesTo18(clockInAt: string): number {
  const start = new Date(clockInAt);
  const end = new Date(start);
  end.setHours(18, 0, 0, 0);
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function AttendanceRowTr({
  r, date, onClick, hideDept, onForceClockOut,
}: {
  r: AttendanceDetailRow; date: string; onClick: () => void; hideDept?: boolean;
  onForceClockOut: (row: { recordId: string; clockInAt: string | null }) => void;
}) {
  const isPastDayUnresolved = !r.clockOutAt && date < todayWorkDateKST();
  const isUnconfirmedAfter18 = !r.clockOutAt && !isPastDayUnresolved && new Date().getHours() >= 18 && !!r.clockInAt;
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onClick}>
      <td>
        <div className="chip-row">
          <div className="chip-avatar" style={{ background: r.clockOutAt ? '#2f9e44' : isPastDayUnresolved ? '#e03131' : '#f08c00' }}>{r.name.slice(-2)}</div>
          {r.name}
          <span style={{ fontSize: 11, color: '#2f6feb', marginLeft: 4 }}>상세보기 ▸</span>
        </div>
      </td>
      {!hideDept && <td>{r.department}</td>}
      <td>{fmtTime(r.clockInAt)}</td>
      <td>
        {r.clockOutAt ? (
          <>
            {fmtTime(r.clockOutAt)}
            {r.isCorrected && r.correctionReason && (
              // 강제확정(관리자)/위치이탈 자동감지 확정 등으로 정정된 기록임을 배지로 표시 —
              // 사유(추정시각 등 원래 제안 내용)는 마우스를 올리면 툴팁으로 확인할 수 있다.
              <div
                style={{ fontSize: 11, color: '#e8590c', fontWeight: 600, marginTop: 2, cursor: 'help' }}
                title={r.correctionReason}
              >
                ✏️ 정정됨
              </div>
            )}
            {r.clockOutLocation && <div style={{ fontSize: 11, color: '#868e96' }}>📍 {r.clockOutLocation}</div>}
          </>
        ) : isPastDayUnresolved ? (
          <span
            style={{ color: '#e03131', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}
            title="클릭해서 실제 퇴근 시각을 입력하고 정정합니다"
            onClick={(e) => { e.stopPropagation(); onForceClockOut({ recordId: r.recordId, clockInAt: r.clockInAt }); }}
          >
            ⚠ 미해결(지난 근무일) — 클릭해서 정정
          </span>
        ) : isUnconfirmedAfter18 ? (
          // 2026-09-01: 저녁 6시(정규 퇴근 마감 기본값)가 지나도록 퇴근을 안 누른 경우를
          // "진행중"과 구분해서 보여준다 — 화면만 다르게 보일 뿐, 여기서 clockOutAt을 자동으로
          // 채우지는 않는다(시스템이 근로시간을 일방적으로 확정하지 않는다는 원칙 유지). 실제
          // 값은 여전히 본인의 퇴근 버튼 클릭 또는 정정 신청으로만 채워진다.
          <span style={{ color: '#e8590c', fontWeight: 600 }} title="18시가 지났지만 아직 퇴근 버튼을 누르지 않았습니다">
            ⏰ 18시 경과 · 퇴근 미확정
          </span>
        ) : (
          <span style={{ color: '#f08c00', fontWeight: 600 }}>● 진행중</span>
        )}
      </td>
      <td>
        {r.totalWorkedMinutes != null ? (
          hoursLabel(r.totalWorkedMinutes)
        ) : isUnconfirmedAfter18 && r.clockInAt ? (
          <span style={{ color: '#e8590c' }} title="18시 기준으로 어림 계산한 값 — 확정 아님(정정신청 승인 시 실제 값으로 바뀜)">
            {hoursLabel(tentativeMinutesTo18(r.clockInAt))} (18시 기준 잠정)
          </span>
        ) : (
          '-'
        )}
      </td>
    </tr>
  );
}

export default function AdminReportsPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('day');
  const [anchor, setAnchor] = useState(new Date());
  const [worktime, setWorktime] = useState<WorktimeSummary | null>(null);
  const [attendanceDetail, setAttendanceDetail] = useState<AttendanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 년/월/일을 직접 선택하는 기간 — 지정하면 위 탭(일/주/월/년)보다 우선한다. 출퇴근·근로시간 공통 적용.
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [timelineTarget, setTimelineTarget] = useState<{ userId: string; date: string } | null>(null);
  const [groupByDept, setGroupByDept] = useState(true);
  const [timeline, setTimeline] = useState<DailyTimeline | null>(null);
  const [forceClockOutTarget, setForceClockOutTarget] = useState<string | null>(null);
  const [forceClockOutTime, setForceClockOutTime] = useState('');
  const [forceClockOutReason, setForceClockOutReason] = useState('');
  const [forceClockOutSubmitting, setForceClockOutSubmitting] = useState(false);

  // "⚠ 미해결(지난 근무일)" 표시를 클릭하면 연다 — 별도 목록 화면을 따로 두지 않고,
  // 이미 보고 있는 출퇴근 현황 표에서 바로 정정할 수 있게 한다.
  function openForceClockOut(row: { recordId: string; clockInAt: string | null }) {
    if (!row.clockInAt) return;
    setForceClockOutTarget(row.recordId);
    // 기본값: 출근 후 8시간(일반적인 하루치 근무) — 관리자가 실제 시각으로 바꿔서 입력한다.
    setForceClockOutTime(toDateTimeLocal(new Date(new Date(row.clockInAt).getTime() + 8 * 60 * 60 * 1000)));
    setForceClockOutReason('');
  }

  function refreshCurrentView() {
    if (isSingleDay) {
      apiFetch<AttendanceDetail>(`/reports/attendance-detail?date=${effectiveFrom}`).then(setAttendanceDetail).catch(() => {});
    } else {
      apiFetch<WorktimeSummary>(`/reports/worktime-summary?from=${effectiveFrom}&to=${effectiveTo}`).then(setWorktime).catch(() => {});
    }
  }

  async function submitForceClockOut() {
    if (!forceClockOutTarget || !forceClockOutTime || !forceClockOutReason.trim()) return;
    setForceClockOutSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/reports/unresolved-clockouts/${forceClockOutTarget}/force-clock-out`, {
        method: 'POST',
        body: JSON.stringify({ clockOutAt: forceClockOutTime, reason: forceClockOutReason.trim() }),
      });
      setForceClockOutTarget(null);
      refreshCurrentView();
    } catch (err) {
      setError(err instanceof Error ? err.message : '강제 퇴근 처리에 실패했습니다.');
    } finally {
      setForceClockOutSubmitting(false);
    }
  }

  function openTimeline(userId: string, date: string) {
    setTimelineTarget({ userId, date });
    setTimeline(null);
    apiFetch<DailyTimeline>(`/reports/daily-timeline?date=${date}&userId=${userId}`)
      .then(setTimeline)
      .catch((err) => setError(err instanceof Error ? err.message : '타임라인을 불러오지 못했습니다.'));
  }

  const tabRange = useMemo(() => computeRange(period, anchor), [period, anchor]);
  const isCustom = Boolean(customFrom && customTo);
  const effectiveFrom = isCustom ? customFrom : fmt(tabRange.from);
  const effectiveTo = isCustom ? customTo : fmt(tabRange.to);
  const isSingleDay = effectiveFrom === effectiveTo;
  const rangeLabel = isCustom ? `${customFrom} ~ ${customTo}(직접 선택)` : tabRange.label;

  useEffect(() => {
    setError(null);
    if (isSingleDay) {
      setWorktime(null);
      apiFetch<AttendanceDetail>(`/reports/attendance-detail?date=${effectiveFrom}`)
        .then(setAttendanceDetail)
        .catch((err) => {
          if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
          setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
        });
    } else {
      setAttendanceDetail(null);
      apiFetch<WorktimeSummary>(`/reports/worktime-summary?from=${effectiveFrom}&to=${effectiveTo}`)
        .then(setWorktime)
        .catch((err) => setError(err instanceof Error ? err.message : '오류가 발생했습니다.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFrom, effectiveTo, isSingleDay]);

  function selectTab(p: Period) {
    setCustomFrom('');
    setCustomTo('');
    setPeriod(p);
  }

  // 요약 카드 계산
  const daySummary = useMemo(() => {
    if (!attendanceDetail) return null;
    const total = attendanceDetail.rows.length;
    const inProgress = attendanceDetail.rows.filter((r) => r.clockInAt && !r.clockOutAt).length;
    const done = attendanceDetail.rows.filter((r) => r.clockOutAt).length;
    return { total, inProgress, done };
  }, [attendanceDetail]);

  // 부서별 보기 — 조직도(부서명) 기준으로 묶어서, 부서명은 가나다순 / 부서 안에서는 출근시각순으로 보여준다.
  const attendanceByDept = useMemo(() => {
    if (!attendanceDetail) return null;
    const map = new Map<string, AttendanceDetailRow[]>();
    for (const r of attendanceDetail.rows) {
      const key = r.department || '(부서 미지정)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([department, rows]) => ({
        department,
        rows: [...rows].sort((a, b) => (a.clockInAt ?? '').localeCompare(b.clockInAt ?? '')),
      }));
  }, [attendanceDetail]);

  // "전체 목록 보기"용 — 부서별 보기와 달리 부서 구분이 없으므로, 다른 화면과 통일되게 이름
  // 가나다순으로 보여준다(2026-09-02).
  const attendanceRowsSorted = useMemo(() => {
    if (!attendanceDetail) return [];
    return [...attendanceDetail.rows].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [attendanceDetail]);

  // 근무시간 누계 표도 동일하게 이름 가나다순으로 통일(2026-09-02).
  const worktimeRowsSorted = useMemo(() => {
    if (!worktime) return [];
    return [...worktime.rows].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [worktime]);

  const periodSummary = useMemo(() => {
    if (!worktime) return null;
    const total = worktime.rows.length;
    const totalMinutes = worktime.rows.reduce((s, r) => s + r.totalMinutes, 0);
    const avgMinutes = total > 0 ? Math.round(totalMinutes / total) : 0;
    const overCount = period === 'week' && !isCustom ? worktime.rows.filter((r) => r.totalMinutes > WEEKLY_LIMIT_MINUTES).length : 0;
    return { total, avgMinutes, overCount };
  }, [worktime, period, isCustom]);

  return (
    <div className="admin-shell">
      <AdminHeader title="출/퇴근·근로시간" />
      <p className="admin-page-subtitle">기간별 출퇴근 현황과 근로시간을 조회하고 내려받으세요. (고객사별 공수는 "고객사별 공수관리" 메뉴로 옮겼습니다)</p>
      {error && <div className="error">{error}</div>}

      {forceClockOutTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 420, width: '100%' }}>
            <h2 style={{ marginTop: 0 }}>🚪 강제 퇴근 처리</h2>
            <p style={{ fontSize: 13, color: '#495057' }}>실제로 근무를 마친 시각과 사유를 입력해주세요. 이 기록은 정정 이력으로 남습니다.</p>
            <label className="field-label">퇴근 시각</label>
            <input type="datetime-local" value={forceClockOutTime} onChange={(e) => setForceClockOutTime(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12 }} />
            <label className="field-label">사유</label>
            <input
              type="text"
              value={forceClockOutReason}
              onChange={(e) => setForceClockOutReason(e.target.value)}
              placeholder="예: 본인 확인 결과 실제 익일 오전까지 근무, 정정 신청 창 초과로 관리자가 직접 확정"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 16 }}
            />
            <button disabled={forceClockOutSubmitting || !forceClockOutReason.trim()} onClick={submitForceClockOut}>
              {forceClockOutSubmitting ? '처리 중...' : '확정'}
            </button>
            <button className="secondary" disabled={forceClockOutSubmitting} onClick={() => setForceClockOutTarget(null)}>취소</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button key={p} className={period === p && !isCustom ? '' : 'secondary'} style={{ width: 'auto' }} onClick={() => selectTab(p)}>
            {PERIOD_LABELS[p]}별
          </button>
        ))}
        <div className="spacer" />
        <button className="secondary" style={{ width: 'auto' }} disabled={isCustom} onClick={() => setAnchor(shiftAnchor(period, anchor, -1))}>‹ 이전</button>
        <span style={{ fontWeight: 700, minWidth: 160, textAlign: 'center' }}>{rangeLabel}</span>
        <button className="secondary" style={{ width: 'auto' }} disabled={isCustom} onClick={() => setAnchor(shiftAnchor(period, anchor, 1))}>다음 ›</button>
        <button className="secondary" style={{ width: 'auto' }} onClick={() => { setCustomFrom(''); setCustomTo(''); setAnchor(new Date()); }}>오늘</button>
      </div>

      {/* 년/월/일을 직접 선택하는 기간 — 출퇴근/근로시간/공수 전체에 공통 적용 */}
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

      {/* 요약 카드 */}
      {isSingleDay && daySummary && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">👥 활동 인원</div>
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
      {!isSingleDay && periodSummary && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">👥 근무 인원</div>
            <div className="stat-value">{periodSummary.total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">⏱️ 1인 평균</div>
            <div className="stat-value">{hoursLabel(periodSummary.avgMinutes)}</div>
          </div>
          {period === 'week' && !isCustom && (
            <div className="stat-card">
              <div className="stat-label">⚠️ 52시간 초과</div>
              <div className="stat-value" style={{ color: periodSummary.overCount > 0 ? '#e03131' : '#495057' }}>{periodSummary.overCount}명</div>
            </div>
          )}
        </div>
      )}

      {/* 하루 단위: 출퇴근 상세표 */}
      {isSingleDay && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <h2>🕒 출퇴근 현황 — {rangeLabel}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                style={{ width: 'auto', margin: 0 }}
                className={groupByDept ? undefined : 'secondary'}
                onClick={() => setGroupByDept((v) => !v)}
              >
                {groupByDept ? '👥 부서별 보기 중' : '📋 전체 목록 보기 중'}
              </button>
              <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
                CSV 내려받기
              </button>
            </div>
          </div>
          {!attendanceDetail && <div className="board-empty">불러오는 중...</div>}
          {attendanceDetail && attendanceDetail.rows.length === 0 && <div className="board-empty">이 날짜에 출근 기록이 없습니다.</div>}

          {attendanceDetail && attendanceDetail.rows.length > 0 && !groupByDept && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>이름</th><th>부서</th><th>출근</th><th>퇴근</th><th>근무시간</th></tr>
                </thead>
                <tbody>
                  {attendanceRowsSorted.map((r) => (
                    <AttendanceRowTr key={r.userId} r={r} date={attendanceDetail.date} onClick={() => openTimeline(r.userId, attendanceDetail.date)} onForceClockOut={openForceClockOut} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {attendanceByDept && attendanceByDept.length > 0 && groupByDept && attendanceByDept.map(({ department, rows }) => (
            <div key={department} style={{ marginBottom: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#2f6feb', margin: '10px 0 4px' }}>
                🏷️ {department} <span style={{ color: '#868e96', fontWeight: 400 }}>({rows.length}명)</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>이름</th><th>출근</th><th>퇴근</th><th>근무시간</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <AttendanceRowTr key={r.userId} r={r} date={attendanceDetail!.date} onClick={() => openTimeline(r.userId, attendanceDetail!.date)} onForceClockOut={openForceClockOut} hideDept />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 여러 날: 누적 근무시간 표 */}
      {!isSingleDay && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>📊 근무시간 누계 (주52시간제 기준) — {rangeLabel}</h2>
            <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
              CSV 내려받기
            </button>
          </div>
          {!worktime && <div className="board-empty">불러오는 중...</div>}
          {worktime && worktime.rows.length === 0 && <div className="board-empty">이 기간에 확정된 근무기록이 없습니다.</div>}
          {worktime && worktime.rows.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>이름</th><th>부서</th><th>누계</th><th>근무일수</th></tr>
                </thead>
                <tbody>
                  {worktimeRowsSorted.map((r) => {
                    const over = period === 'week' && !isCustom && r.totalMinutes > WEEKLY_LIMIT_MINUTES;
                    return (
                      <tr key={r.userId} style={{ cursor: 'pointer' }} onClick={() => openTimeline(r.userId, fmt(new Date()))}>
                        <td>
                          <div className="chip-row">
                            <div className="chip-avatar" style={{ background: over ? '#e03131' : '#2f6feb' }}>{r.name.slice(-2)}</div>
                            {r.name}
                            <span style={{ fontSize: 11, color: '#2f6feb', marginLeft: 4 }}>오늘 상세 ▸</span>
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
            </div>
          )}
        </div>
      )}

      {timelineTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, maxWidth: 560, width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
            {!timeline && <div className="board-empty">불러오는 중...</div>}
            {timeline && (
              <>
                <h2 style={{ marginTop: 0 }}>🕒 {timeline.name}님의 {timeline.date} 상세 타임라인</h2>
                <p style={{ fontSize: 13, color: '#495057' }}>
                  {timeline.department} · 출근 {fmtTime(timeline.clockInAt)} · 퇴근 {timeline.clockOutAt ? fmtTime(timeline.clockOutAt) : '진행중'}
                  {timeline.totalWorkedMinutes != null && ` · 근무시간 ${hoursLabel(timeline.totalWorkedMinutes)}`}
                  {timeline.clockOutLocation && ` · 📍 ${timeline.clockOutLocation}`}
                </p>
                {timeline.timeline.length === 0 && <div className="board-empty">이 날짜에 등록된 상태 변경이 없습니다.</div>}
                {timeline.timeline.map((t, i) => {
                  const meta = TIMELINE_STATUS_META[t.status] ?? { label: t.status, icon: '❔', color: '#868e96' };
                  return (
                    <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f3f5' }}>
                      <div style={{ fontSize: 20 }}>{meta.icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong style={{ color: meta.color }}>{meta.label}</strong>
                          <span style={{ fontSize: 13, color: '#495057' }}>
                            {fmtTime(t.changedAt)} · {t.ongoing ? <span style={{ color: '#f08c00' }}>진행중</span> : hoursLabel(t.durationMinutes)}
                          </span>
                        </div>
                        {t.note && <div style={{ fontSize: 12, color: '#868e96', marginTop: 2, fontStyle: 'italic' }}>“{t.note}”</div>}
                      </div>
                    </div>
                  );
                })}
                {/* 목록 맨 아래에 퇴근도 같은 형식(아이콘/시간/부가정보 한 줄)으로 보여준다 —
                    위쪽 요약줄("출근 .. · 퇴근 ..")과 별개로, 몇 시에 어디서 퇴근했는지 더 자세히 볼 수 있게. */}
                {timeline.clockOutAt && (
                  <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f3f5' }}>
                    <div style={{ fontSize: 20 }}>🚪</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong style={{ color: '#2f6feb' }}>퇴근</strong>
                        <span style={{ fontSize: 13, color: '#495057' }}>{fmtTime(timeline.clockOutAt)}</span>
                      </div>
                      {timeline.clockOutLocation && (
                        <div style={{ fontSize: 12, color: '#868e96', marginTop: 2, fontStyle: 'italic' }}>“📍 {timeline.clockOutLocation}”</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
            <button className="secondary" style={{ marginTop: 12 }} onClick={() => { setTimelineTarget(null); setTimeline(null); }}>닫기</button>
          </div>
        </div>
      )}
    </div>
  );
}
