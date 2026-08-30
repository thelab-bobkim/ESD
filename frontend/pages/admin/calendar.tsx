import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

const STATUS_META: Record<string, { label: string; icon: string; color: string }> = {
  HQ_WORKING: { label: '본사근무', icon: '🏢', color: '#2f9e44' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬', color: '#2f9e44' },
  OFFSITE: { label: '외근', icon: '🚗', color: '#1c7ed6' },
  CLIENT_MEETING: { label: '고객사 미팅', icon: '🤝', color: '#1c7ed6' },
  CLIENT_WORK: { label: '고객사 작업', icon: '🛠️', color: '#1c7ed6' },
  MOVING: { label: '이동중', icon: '🚙', color: '#1c7ed6' },
  MEETING: { label: '회의중', icon: '👥', color: '#1c7ed6' },
  REMOTE: { label: '재택(집)', icon: '🏠', color: '#6741d9' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙', color: '#f08c00' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️', color: '#868e96' },
  ON_LEAVE: { label: '휴가', icon: '🌴', color: '#868e96' },
  UNKNOWN: { label: '상태 미확인', icon: '❔', color: '#e03131' },
};
const STATUS_ORDER = [
  'HQ_WORKING', 'RESIDENT_ONSITE', 'OFFSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'MOVING', 'MEETING',
  'REMOTE', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE', 'UNKNOWN',
];
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

interface CalendarDay { date: string; clockedIn: number; workedConfirmed: number; }
interface CalendarData { year: number; month: number; days: CalendarDay[]; }

interface EmployeeRow {
  userId: string; name: string; department: string; client: string | null; workType: string;
  status: string | null; statusChangedAt: string | null; statusSource: string | null; statusNote: string | null;
}
interface DayBoard { date: string; summary: Record<string, number>; employees: EmployeeRow[]; }

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export default function AdminCalendarPage() {
  const router = useRouter();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1~12
  const [calendar, setCalendar] = useState<CalendarData | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayBoard, setDayBoard] = useState<DayBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const todayStr = fmt(now.getFullYear(), now.getMonth() + 1, now.getDate());

  useEffect(() => {
    apiFetch<CalendarData>(`/dashboard/calendar?year=${year}&month=${month}`)
      .then(setCalendar)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const calByDate = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    (calendar?.days ?? []).forEach((d) => map.set(d.date, d));
    return map;
  }, [calendar]);

  const cells = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    // 월요일 시작 기준 빈 칸 수
    const jsDay = firstDay.getDay(); // 0=일요일
    const leadingBlanks = jsDay === 0 ? 6 : jsDay - 1;
    const result: { day: number | null; date: string | null }[] = [];
    for (let i = 0; i < leadingBlanks; i++) result.push({ day: null, date: null });
    for (let d = 1; d <= daysInMonth; d++) result.push({ day: d, date: fmt(year, month, d) });
    return result;
  }, [year, month]);

  function selectDate(date: string) {
    setSelectedDate(date);
    setDayBoard(null);
    apiFetch<DayBoard>(`/dashboard/day?date=${date}`)
      .then(setDayBoard)
      .catch((err) => setError(err instanceof Error ? err.message : '오류가 발생했습니다.'));
  }

  function prevMonth() {
    if (month === 1) { setYear(year - 1); setMonth(12); } else { setMonth(month - 1); }
    setSelectedDate(null);
    setDayBoard(null);
  }
  function nextMonth() {
    if (month === 12) { setYear(year + 1); setMonth(1); } else { setMonth(month + 1); }
    setSelectedDate(null);
    setDayBoard(null);
  }

  return (
    <div className="admin-shell">
      <AdminHeader title="상황판 캘린더" />
      <p className="admin-page-subtitle">날짜를 눌러 그날의 출퇴근·상태 기록을 확인하세요.</p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={prevMonth}>‹ 이전달</button>
          <h2 style={{ margin: 0 }}>{year}년 {month}월</h2>
          <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={nextMonth}>다음달 ›</button>
        </div>

        <div className="calendar-grid" style={{ marginBottom: 6 }}>
          {WEEKDAYS.map((w) => (
            <div className="calendar-weekday" key={w}>{w}</div>
          ))}
        </div>
        <div className="calendar-grid">
          {cells.map((c, i) => {
            if (!c.date) return <div className="calendar-cell empty" key={i} />;
            const info = calByDate.get(c.date);
            const isToday = c.date === todayStr;
            const isSelected = c.date === selectedDate;
            return (
              <div
                key={c.date}
                className={`calendar-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
                onClick={() => selectDate(c.date!)}
              >
                <div className="day-num">{c.day}</div>
                {info && info.clockedIn > 0 && <div className="day-count">출근 {info.clockedIn}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="card">
          <h2>{selectedDate} 상황</h2>
          {!dayBoard && <div className="board-empty">불러오는 중...</div>}
          {dayBoard && (
            <div className="board">
              {STATUS_ORDER.map((code) => {
                const meta = STATUS_META[code];
                const employees = dayBoard.employees.filter((e) => (e.status && STATUS_META[e.status] ? e.status : 'UNKNOWN') === code);
                if (employees.length === 0) return null;
                return (
                  <div className="board-column" key={code} style={{ borderTopColor: meta.color }}>
                    <div className="board-column-header">
                      <span>{meta.icon} {meta.label}</span>
                      <span className="count">{employees.length}</span>
                    </div>
                    {employees.map((e) => (
                      <div className="employee-chip" key={e.userId}>
                        <div className="name">{e.name}</div>
                        <div className="meta">{e.department}</div>
                        {e.statusNote && <div className="meta" style={{ fontStyle: 'italic' }}>“{e.statusNote}”</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
