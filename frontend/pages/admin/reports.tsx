import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiDownload } from '@/lib/api';
import { classifyDeptGroup } from '@/lib/deptGroup';
import AdminHeader from '@/components/AdminHeader';

const WEEKLY_LIMIT_MINUTES = 52 * 60; // 주52시간제 기준
// 서버 정책값(MIN_HOURS_BEFORE_CLOCKOUT) 기본값과 맞춘 표시용 기준 — 관리자가 정책을 다르게
// 설정했더라도 여기서는 "조기퇴근 사유 배지"를 보여줄지 판단하는 용도로만 쓴다(실제 강제는 서버가 함).
const MIN_WORK_MINUTES_DISPLAY = 8 * 60;
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
  WEEKEND_WORK: { label: '주말작업', icon: '🗓️', color: '#f08c00' },
  BUSINESS_TRIP: { label: '출장', icon: '✈️', color: '#1c7ed6' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
};

interface WorktimeRow {
  userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number;
}
interface WorktimeSummary { from: string; to: string; rows: WorktimeRow[]; }

interface AttendanceDetailRow {
  // 2026-09-04: 표시대상(includedInBoard) 전원을 항상 보여주도록 바뀌면서, 그날 아직 아무
  // 기록도 없는 사람은 recordId가 null로 내려온다("미출근" 상태 — 아래 AttendanceRowTr 참고).
  recordId: string | null; userId: string; employeeNo: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; clockOutLocation: string | null; totalWorkedMinutes: number | null;
  // 2026-09-16: 최소 근무시간(정책 기본 8시간) 미만으로 퇴근했을 때 본인이 입력한 조기퇴근 사유 —
  // null이면 사유 없이 확정된 것이라, 퇴근을 잘못 눌렀을 가능성을 관리자가 바로 알아챌 수 있게 쓴다.
  earlyLeaveReason: string | null;
  isCorrected: boolean; correctionReason: string | null;
  // 이동시간(공수 산정용) — 본인이 "이동중"으로 직접 찍은 시간 + 미기록 구간 자동추정치의 합.
  // travelHasEstimate는 그중 일부가 자동추정인지(=실제로 이동중을 안 찍은 구간이 있었는지) 표시한다.
  travelMinutes: number; travelHasEstimate: boolean;
  // 2026-09-04: 미출근이어도 "이동중"처럼 정식 출근으로 안 이어지는 상태를 등록했을 수 있어서,
  // 그날의 가장 최근 상태변경을 같이 받는다 — "출근을 안 찍은 직원이 지금 뭘 하고 있는지"를
  // 이 화면에서 바로 보여주기 위함(admin/board-scope의 로그인 이력과는 별개).
  latestStatus: { status: string; changedAt: string; note: string | null } | null;
  // 2026-09-08: 근무기록은 있는데 출근시각이 없거나 크게 어긋난 경우의 경고(손주용 사례) — null이면 정상.
  clockInMismatch: ClockInMismatch | null;
}
interface AttendanceDetail { date: string; rows: AttendanceDetailRow[]; }

interface ClockInMismatch { firstWorkStatus: string; firstWorkAt: string; diffMinutes: number | null; }

interface TimelineEntry {
  status: string; changedAt: string; note: string | null; durationMinutes: number; ongoing: boolean;
  // true면 본인이 직접 찍은 기록이 아니라, 이동중 미기록 구간에서 자동으로 떼어낸 추정치.
  estimated?: boolean;
}
interface DailyTimeline {
  date: string; name: string; department: string;
  clockInAt: string | null; clockOutAt: string | null; clockOutLocation: string | null; totalWorkedMinutes: number | null;
  earlyLeaveReason: string | null;
  totalTravelMinutes: number;
  timeline: TimelineEntry[];
  clockInMismatch: ClockInMismatch | null;
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
// 2026-09-06: 이동시간처럼 1시간 미만인 경우가 흔해져서, "0시간 31분"처럼 항상 "0시간"을 붙이던
// 것을 "31분"으로 줄였다 — 표가 한결 덜 복잡해 보인다(1시간 이상은 기존과 동일하게 "N시간 M분").
function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
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

// 2026-09-14: "부서별/전체목록 말고 영업부/기술부로도 보고 싶다"는 요청 — 분류 기준(classifyDeptGroup)은
// 고객사별 공수관리 화면의 "엔지니어별" 대상 필터와 같은 기준을 쓴다(src/lib/deptGroup.ts 참고).
type AttendanceViewMode = 'dept' | 'all' | 'sales' | 'tech';
const ATTENDANCE_VIEW_MODES: { key: AttendanceViewMode; label: string; icon: string }[] = [
  { key: 'dept', label: '부서별 보기', icon: '👥' },
  { key: 'all', label: '전체 목록 보기', icon: '📋' },
  { key: 'sales', label: '영업부만 보기', icon: '💼' },
  { key: 'tech', label: '기술부만 보기', icon: '🔧' },
];

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
  // 2026-09-04: 그날 아예 아무 기록도 없는 사람("미출근" — 앱을 안 쓴 건지, 정말 안 나온 건지는
  // 별도로 admin/board-scope의 로그인 이력에서 확인) — 이 경우엔 "정정 필요"가 아니라 그냥
  // "출근 자체가 없었다"는 걸로, 아래의 출근-후-미해결 상태와는 구분해서 보여준다.
  const neverClockedIn = !r.clockInAt;
  const isPastDayUnresolved = !neverClockedIn && !r.clockOutAt && date < todayWorkDateKST();
  const isUnconfirmedAfter18 = !neverClockedIn && !r.clockOutAt && !isPastDayUnresolved && new Date().getHours() >= 18;
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onClick}>
      <td>
        <div className="chip-row">
          <div className="chip-avatar" style={{ background: r.clockOutAt ? '#2f9e44' : neverClockedIn ? (r.latestStatus ? '#1c7ed6' : '#94a3b8') : isPastDayUnresolved ? '#e03131' : '#f08c00' }}>{r.name.slice(-2)}</div>
          {r.name}
          <span style={{ fontSize: 11, color: '#2f6feb', marginLeft: 4 }}>상세보기 ▸</span>
        </div>
      </td>
      {!hideDept && <td>{r.department}</td>}
      <td className="num">
        {fmtTime(r.clockInAt)}
        {r.clockInMismatch && (
          <span
            className="att-pill att-pill-danger"
            style={{ marginLeft: 6 }}
            title={`${TIMELINE_STATUS_META[r.clockInMismatch.firstWorkStatus]?.label ?? r.clockInMismatch.firstWorkStatus} 최초 근무기록은 ${fmtTime(r.clockInMismatch.firstWorkAt)}인데 출근시각과 ${r.clockInMismatch.diffMinutes != null ? `${r.clockInMismatch.diffMinutes}분 차이가 나요` : '출근기록 자체가 없어요'} — 클릭해서 상세 타임라인을 확인해주세요.`}
          >
            ⚠ 불일치
          </span>
        )}
      </td>
      <td className="num">
        {/* 2026-09-06: 이동시간은 실제 근무시간과 이동시간을 구분해서 보려는 목적이 커서(예:
            상주/출장이 잦은 직원의 실근무 대비 이동 비중 파악), 다른 숫자 열처럼 맨 텍스트로
            묻히지 않게 눈에 띄는 색상 알약(pill)으로 항상 강조해서 보여준다. */}
        {r.travelMinutes > 0 ? (
          <span className="att-pill att-pill-travel" title={r.travelHasEstimate ? '이동중 상태를 직접 찍지 않은 구간이 있어 일부는 자동추정치입니다.' : undefined}>
            🚙 {hoursLabel(r.travelMinutes)}
            {r.travelHasEstimate && <span className="att-travel-est">추정</span>}
          </span>
        ) : (
          <span style={{ color: 'var(--dsti-text-faint)' }}>-</span>
        )}
      </td>
      <td className="num">
        {r.clockOutAt ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <span className="num">{fmtTime(r.clockOutAt)}</span>
              {r.isCorrected && r.correctionReason && (
                // 강제확정(관리자)/위치이탈 자동감지 확정 등으로 정정된 기록임을 배지로 표시 —
                // 사유(추정시각 등 원래 제안 내용)는 마우스를 올리면 툴팁으로 확인할 수 있다.
                <span className="att-pill att-pill-warn" title={r.correctionReason}>✏️ 정정됨</span>
              )}
            </div>
            {r.clockOutLocation && <div className="att-addr" title={r.clockOutLocation}>📍 {r.clockOutLocation}</div>}
          </div>
        ) : neverClockedIn ? (
          r.latestStatus ? (
            // 2026-09-04: 정식 출근으로는 안 이어지는 상태("이동중" 등)만 찍은 경우 — 미출근이라도
            // 지금 뭘 하고 있는지 짐작할 단서가 있다는 뜻이라 "미출근" 대신 그 상태를 보여준다.
            <span
              className="att-pill att-pill-info"
              title={`${fmtTime(r.latestStatus.changedAt)}에 마지막으로 등록한 상태입니다. 정식 출근으로는 아직 이어지지 않았어요.${r.latestStatus.note ? ` (메모: ${r.latestStatus.note})` : ''}`}
            >
              {TIMELINE_STATUS_META[r.latestStatus.status]?.icon ?? '❔'} {TIMELINE_STATUS_META[r.latestStatus.status]?.label ?? r.latestStatus.status} · {fmtTime(r.latestStatus.changedAt)}
            </span>
          ) : (
            <span className="att-pill att-pill-neutral" title="이 날짜에 출근을 포함해 아무 상태도 등록하지 않았습니다 — 앱을 아예 안 쓰고 있을 수 있습니다. '표시 대상 관리' 화면의 로그인 이력을 확인해보세요.">
              ⚪ 미출근
            </span>
          )
        ) : isPastDayUnresolved ? (
          <span
            className="att-pill att-pill-danger"
            title="클릭해서 실제 퇴근 시각을 입력하고 정정합니다"
            onClick={(e) => { e.stopPropagation(); if (r.recordId) onForceClockOut({ recordId: r.recordId, clockInAt: r.clockInAt }); }}
          >
            ⚠ 미해결 · 정정필요
          </span>
        ) : isUnconfirmedAfter18 ? (
          // 2026-09-01: 저녁 6시(정규 퇴근 마감 기본값)가 지나도록 퇴근을 안 누른 경우를
          // "진행중"과 구분해서 보여준다 — 화면만 다르게 보일 뿐, 여기서 clockOutAt을 자동으로
          // 채우지는 않는다(시스템이 근로시간을 일방적으로 확정하지 않는다는 원칙 유지). 실제
          // 값은 여전히 본인의 퇴근 버튼 클릭 또는 정정 신청으로만 채워진다.
          <span className="att-pill att-pill-warn" title="18시가 지났지만 아직 퇴근 버튼을 누르지 않았습니다">
            ⏰ 18시 경과
          </span>
        ) : (
          <span className="att-pill att-pill-info">● 진행중</span>
        )}
      </td>
      <td className="num">
        {r.totalWorkedMinutes != null ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span>{hoursLabel(r.totalWorkedMinutes)}</span>
            {/* 2026-09-16: 최소 근무시간(정책 기본값 8시간) 미만으로 확정된 날 — 조기퇴근 사유가
                있으면 참고용 배지만, 없으면 "퇴근을 잘못 눌렀을 가능성"으로 보고 눈에 띄게 경고한다.
                (한상호·박상민님 사례처럼 근무 3~4시간 만에 퇴근이 찍힌 케이스를 관리자가 목록에서
                바로 알아볼 수 있도록 — 클릭해서 상세 타임라인/사유를 확인해달라는 의미.) */}
            {r.totalWorkedMinutes < MIN_WORK_MINUTES_DISPLAY && (
              r.earlyLeaveReason ? (
                <span className="att-pill att-pill-warn" title={`조기퇴근 사유: ${r.earlyLeaveReason}`}>
                  🕒 조기퇴근 사유 있음
                </span>
              ) : (
                <span
                  className="att-pill att-pill-danger"
                  title="최소 근무시간(8시간) 미만인데 조기퇴근 사유가 없습니다 — 퇴근을 잘못 눌렀을 가능성이 있어요. 클릭해서 확인해주세요."
                >
                  ⚠ 사유 없음·확인필요
                </span>
              )
            )}
          </div>
        ) : isUnconfirmedAfter18 && r.clockInAt ? (
          <span title="18시 기준으로 어림 계산한 값 — 확정 아님(정정신청 승인 시 실제 값으로 바뀜)">
            {hoursLabel(tentativeMinutesTo18(r.clockInAt))}
            <span className="att-pill att-pill-neutral" style={{ marginLeft: 6 }}>잠정</span>
          </span>
        ) : (
          <span style={{ color: 'var(--dsti-text-faint)' }}>-</span>
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
  // 2026-09-14: 부서별/전체목록 2단 토글을 부서별/전체목록/영업부만/기술부만 4단으로 확장했다
  // (ATTENDANCE_VIEW_MODES 참고).
  const [viewMode, setViewMode] = useState<AttendanceViewMode>('dept');
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

  // "영업부만/기술부만 보기" — 부서별 보기와 같은 구조(부서 구분줄 + 그 안에 출근시각순)를 쓰되,
  // classifyDeptGroup 기준에 맞는 부서만 남긴다.
  const attendanceGroupsToRender = useMemo(() => {
    if (!attendanceByDept) return null;
    if (viewMode === 'sales' || viewMode === 'tech') {
      return attendanceByDept.filter((g) => classifyDeptGroup(g.department) === viewMode);
    }
    return attendanceByDept;
  }, [attendanceByDept, viewMode]);
  const isGroupedView = viewMode !== 'all';
  // 영업부/기술부만 보기인데 해당 부서가 아예 없으면(전 직원이 다른 분류) 표 자체를 숨기고
  // 안내문만 보여준다.
  const hasNoMatchingDeptGroup = (viewMode === 'sales' || viewMode === 'tech') && (attendanceGroupsToRender?.length ?? 0) === 0;

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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {ATTENDANCE_VIEW_MODES.map((m) => (
                <button
                  key={m.key}
                  style={{ width: 'auto', margin: 0 }}
                  className={viewMode === m.key ? undefined : 'secondary'}
                  onClick={() => setViewMode(m.key)}
                >
                  {m.icon} {m.label}
                </button>
              ))}
              <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
                CSV 내려받기
              </button>
              {/* 2026-09-18: "이 화면 CSV엔 왜 고객사 정보가 없냐"는 문의 대응 — 이 CSV(근태)는
                  출퇴근 기록이라 애초에 고객사 개념이 없다. 일별·사용자별·고객사별 작업시간은
                  별도 데이터(공수기록)라서, 헷갈리지 않게 바로 옆에 전용 다운로드 버튼을 둔다. */}
              <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/client-work-daily-export', 'client-work-daily-export.csv')}>
                📊 일별 고객사 작업시간 CSV
              </button>
            </div>
          </div>
          {!attendanceDetail && <div className="board-empty">불러오는 중...</div>}
          {attendanceDetail && attendanceDetail.rows.length === 0 && <div className="board-empty">이 날짜에 출근 기록이 없습니다.</div>}
          {attendanceDetail && attendanceDetail.rows.length > 0 && hasNoMatchingDeptGroup && (
            <div className="board-empty">{viewMode === 'sales' ? '영업부' : '기술부'}로 분류되는 부서에 등록된 인원이 없습니다.</div>
          )}

          {/* 2026-09-06: 부서마다 표를 따로 그리던 것을(헤더가 부서 수만큼 반복되어 복잡해 보임) 표
              하나 + 부서 구분줄로 통일했다. 표 틀은 부서별/전체 보기 모두 동일하고, 부서별로 묶어서
              보여줄 때만(부서별/영업부만/기술부만) "부서" 열 대신 구분줄로 부서를 나눈다. */}
          {attendanceDetail && attendanceDetail.rows.length > 0 && !hasNoMatchingDeptGroup && (
            <div className="table-scroll">
              <table className="att-table att-table--daily">
                {/* 2026-09-06: 열 너비를 브라우저 자동계산에 맡기면 "이름" 열이 내용 없이도 과하게
                    넓어지고 정작 중요한 이동/근무시간 등은 좁게 눌리는 문제가 있었다. table-layout:
                    fixed + colgroup으로 열 비율을 직접 지정해 항상 같은 균형을 유지한다. 이동시간은
                    이동경로 파악에 중요한 정보라 다른 숫자 열보다 살짝 더 넓게 잡았다. */}
                <colgroup>
                  <col style={{ width: isGroupedView ? '26%' : '20%' }} />
                  {!isGroupedView && <col style={{ width: '13%' }} />}
                  <col style={{ width: isGroupedView ? '13%' : '12%' }} />
                  <col style={{ width: isGroupedView ? '18%' : '17%' }} />
                  <col style={{ width: isGroupedView ? '28%' : '23%' }} />
                  <col style={{ width: '15%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>이름</th>
                    {!isGroupedView && <th>부서</th>}
                    <th className="num">출근</th>
                    <th className="num">🚙 이동</th>
                    <th className="num">퇴근</th>
                    <th className="num">근무시간</th>
                  </tr>
                </thead>
                <tbody>
                  {isGroupedView
                    ? attendanceGroupsToRender?.flatMap(({ department, rows }) => [
                        <tr className="att-dept-row" key={`dept-${department}`}>
                          <td colSpan={5}>🏷️ {department}<span className="att-dept-count">{rows.length}명</span></td>
                        </tr>,
                        ...rows.map((r) => (
                          <AttendanceRowTr key={r.userId} r={r} date={attendanceDetail.date} onClick={() => openTimeline(r.userId, attendanceDetail.date)} onForceClockOut={openForceClockOut} hideDept />
                        )),
                      ])
                    : attendanceRowsSorted.map((r) => (
                        <AttendanceRowTr key={r.userId} r={r} date={attendanceDetail.date} onClick={() => openTimeline(r.userId, attendanceDetail.date)} onForceClockOut={openForceClockOut} />
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 여러 날: 누적 근무시간 표 */}
      {!isSingleDay && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <h2>📊 근무시간 누계 (주52시간제 기준) — {rangeLabel}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/attendance-export', 'attendance-export.csv')}>
                CSV 내려받기
              </button>
              <button style={{ width: 'auto', margin: 0 }} className="secondary" onClick={() => apiDownload('/reports/client-work-daily-export', 'client-work-daily-export.csv')}>
                📊 일별 고객사 작업시간 CSV
              </button>
            </div>
          </div>
          {!worktime && <div className="board-empty">불러오는 중...</div>}
          {worktime && worktime.rows.length === 0 && <div className="board-empty">이 기간에 확정된 근무기록이 없습니다.</div>}
          {worktime && worktime.rows.length > 0 && (
            <div className="table-scroll">
              <table className="att-table">
                <thead>
                  <tr><th>이름</th><th>부서</th><th className="num">누계</th><th className="num">근무일수</th></tr>
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
                        <td className="num" style={{ color: over ? '#e03131' : undefined, fontWeight: over ? 700 : undefined }}>
                          {hoursLabel(r.totalMinutes)}
                          {over && <span className="att-pill att-pill-danger" style={{ marginLeft: 6, cursor: 'default' }}>⚠ 52시간 초과</span>}
                        </td>
                        <td className="num">{r.days}일</td>
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
                  {timeline.totalTravelMinutes > 0 && ` · 🚙 이동시간 ${hoursLabel(timeline.totalTravelMinutes)}`}
                  {timeline.clockOutLocation && ` · 📍 ${timeline.clockOutLocation}`}
                </p>
                {timeline.clockInMismatch && (
                  <div className="att-pill att-pill-danger" style={{ marginBottom: 12, display: 'inline-block' }}>
                    ⚠ 출근시각 불일치 — {TIMELINE_STATUS_META[timeline.clockInMismatch.firstWorkStatus]?.label ?? timeline.clockInMismatch.firstWorkStatus} 최초기록 {fmtTime(timeline.clockInMismatch.firstWorkAt)}
                    {timeline.clockInMismatch.diffMinutes != null ? ` (출근시각과 ${timeline.clockInMismatch.diffMinutes}분 차이)` : ' · 출근기록 자체가 없어요'}
                  </div>
                )}
                {timeline.timeline.length === 0 && <div className="board-empty">이 날짜에 등록된 상태 변경이 없습니다.</div>}
                {timeline.timeline.map((t, i) => {
                  const meta = TIMELINE_STATUS_META[t.status] ?? { label: t.status, icon: '❔', color: '#868e96' };
                  return (
                    <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f3f5' }}>
                      <div style={{ fontSize: 20 }}>{meta.icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong style={{ color: meta.color }}>
                            {meta.label}
                            {t.estimated && (
                              <span
                                className="att-pill att-pill-info"
                                style={{ marginLeft: 6 }}
                                title="이동중 상태를 직접 찍지 않아 시스템이 정책 기본값만큼 자동으로 떼어낸 추정치입니다."
                              >
                                자동추정
                              </span>
                            )}
                          </strong>
                          <span style={{ fontSize: 13, color: '#495057' }}>
                            {fmtTime(t.changedAt)} · {t.ongoing ? <span className="att-pill att-pill-warn">진행중</span> : hoursLabel(t.durationMinutes)}
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
                      {timeline.earlyLeaveReason ? (
                        <div style={{ fontSize: 12, color: '#e8590c', marginTop: 4 }}>🕒 조기퇴근 사유: {timeline.earlyLeaveReason}</div>
                      ) : timeline.totalWorkedMinutes != null && timeline.totalWorkedMinutes < MIN_WORK_MINUTES_DISPLAY ? (
                        <div style={{ fontSize: 12, color: '#e03131', marginTop: 4, fontWeight: 600 }}>
                          ⚠ 최소 근무시간(8시간) 미만인데 조기퇴근 사유가 없어요 — 퇴근을 잘못 눌렀을 가능성이 있습니다.
                        </div>
                      ) : null}
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
