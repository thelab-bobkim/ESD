import { useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

interface AttendanceCodeGroup {
  dayWorkStatusCode: string | null;
  workGroupCode: string | null;
  shiftWorkPolicyCode: string | null;
  hasStartWorkTime: boolean;
  count: number;
  samples: {
    loginId?: string; name?: string; accrualDate?: string;
    startWorkTime?: string | null; endWorkTime?: string | null;
    isWorkingDay?: boolean; sumWorkingHours?: string;
  }[];
}
interface ProbeResult { totalElements: number; groups: AttendanceCodeGroup[] }

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 다우오피스 휴가현황 연동 가능 여부를 확인하기 위한 1회성 진단 화면(2026-09-04 추가).
 * 다우오피스 오픈API 공식 문서에는 "휴가/휴가현황"을 별도로 조회하는 API가 없고, 근태(출퇴근)
 * 조회 API(attnd-v2/attnd) 응답의 dayWorkStatusCode가 정상출근/휴가/외근 등을 구분해줄 것으로
 * "추정"만 되는 상태였다. 이 화면은 그 추정을 실데이터로 검증하기 위한 것 — DB에는 아무것도
 * 쓰지 않고, 코드값 조합별로 몇 명이 잡히는지 + 실제 이름/날짜 샘플을 보여준다.
 * 다우오피스 "전사 휴가현황" 화면에서 실제로 휴가였던 사람·날짜와 여기 결과를 대조해서
 * "이 코드가 휴가구나"를 확인하면, 그 코드를 기준으로 정식 연동 기능(휴가 상태 자동 표시)을
 * 만들 수 있다. 확인이 끝나면 이 진단 화면은 지워도 된다.
 */
export default function AdminDauofficeProbePage() {
  const [startDate, setStartDate] = useState(daysAgoISO(7));
  const [endDate, setEndDate] = useState(todayISO());
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ProbeResult>(
        `/dauoffice/probe/attendance-codes?startDate=${startDate}&endDate=${endDate}`
      );
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  // 출근시각이 아예 없는(hasStartWorkTime=false) 코드 조합을 위로 올려서 먼저 보게 한다 —
  // 휴가는 정의상 출근을 안 하므로, 이 조합들이 "휴가 후보"일 확률이 가장 높다.
  const sortedGroups = useMemo(() => {
    if (!result) return [];
    return [...result.groups].sort((a, b) => {
      if (a.hasStartWorkTime !== b.hasStartWorkTime) return a.hasStartWorkTime ? 1 : -1;
      return b.count - a.count;
    });
  }, [result]);

  return (
    <div className="admin-shell">
      <AdminHeader title="다우오피스 코드 진단" />
      <p className="admin-page-subtitle">
        휴가현황 연동 가능 여부를 확인하기 위한 1회성 진단 도구입니다. DB에는 아무것도 저장하지
        않고, 다우오피스 근태 API 응답을 코드값별로 모아서 그대로 보여줍니다. 출근시각이 없는
        (hasStartWorkTime=아니오) 조합이 휴가일 가능성이 가장 높습니다 — 아래 이름·날짜를
        다우오피스 &quot;전사 휴가현황&quot; 화면과 대조해보세요.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          시작일
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ width: 'auto' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          종료일
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ width: 'auto' }} />
        </label>
        <div className="spacer" />
        <button style={{ width: 'auto' }} onClick={run} disabled={loading}>
          {loading ? '조회 중...' : '조회'}
        </button>
      </div>

      {result && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>총 {result.totalElements}건 · {result.groups.length}개 코드 조합</h2>
          <div className="table-scroll">
            <table className="att-table">
              <thead>
                <tr>
                  <th>dayWorkStatusCode</th>
                  <th>workGroupCode</th>
                  <th>shiftWorkPolicyCode</th>
                  <th>출근시각 있음</th>
                  <th>건수</th>
                  <th>샘플 (이름 · 날짜 · 출근시각 · 근무일여부 · 총근무시간)</th>
                </tr>
              </thead>
              <tbody>
                {sortedGroups.map((g, i) => (
                  <tr key={i}>
                    <td className="num">{g.dayWorkStatusCode ?? <span style={{ color: 'var(--dsti-text-faint)' }}>null</span>}</td>
                    <td className="num">{g.workGroupCode ?? '-'}</td>
                    <td className="num">{g.shiftWorkPolicyCode ?? '-'}</td>
                    <td>
                      {g.hasStartWorkTime ? (
                        <span className="att-pill att-pill-ok">예</span>
                      ) : (
                        <span className="att-pill att-pill-warn" title="출근시각이 없습니다 — 휴가일 가능성이 높습니다">아니오 (휴가 후보)</span>
                      )}
                    </td>
                    <td className="num">{g.count}</td>
                    <td style={{ fontSize: 12 }}>
                      {g.samples.map((s, j) => (
                        <div key={j}>
                          {s.name}({s.loginId}) · {s.accrualDate} · {s.startWorkTime ?? '출근없음'} · {s.isWorkingDay === false ? '휴무일' : s.isWorkingDay === true ? '근무일' : '-'} · {s.sumWorkingHours ?? '-'}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
