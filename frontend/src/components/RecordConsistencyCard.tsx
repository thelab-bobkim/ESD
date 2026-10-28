import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

/**
 * 기록 불일치 점검 (2026-10-28) — 퇴근 정정 요청을 위치 기록·마지막 활동·사유 속 시각과 대조해
 * 관리자가 확인해 볼 목록을 보여준다. 판정이 아니라 확인 대상이며, 좌표는 표시하지 않는다.
 */
interface Row {
  id: string; userName: string; workDate: string; clockInAt: string; proposedClockOutAt: string;
  status: string; isAuto: boolean; flags: string[]; lastActivityAt: string | null;
  presenceBasisAt: string | null; presenceDiffMin: number | null; blocks: number;
}
interface Summary {
  total: number; manual: number; default9h: number; reasonMismatch: number;
  activityAfter: number; presenceGap: number; withPresence: number; systemBarrier: number;
}
interface UserAgg {
  userName: string; total: number; manual: number; default9h: number; mismatch: number; activityAfter: number;
}
interface Data { days: number; summary: Summary; users: UserAgg[]; rows: Row[] }

const FLAG_LABEL: Record<string, string> = {
  DEFAULT_9H: '기본값(출근+9시간) 추정',
  REASON_TIME_MISMATCH: '사유 속 시각과 다름',
  ACTIVITY_AFTER: '퇴근 이후 활동 있음',
  PRESENCE_GAP: '위치 기록과 차이',
  SYSTEM_BARRIER: '위치 차단 반복(시스템 장벽)',
};
const FLAG_COLOR: Record<string, string> = {
  DEFAULT_9H: '#b45309', REASON_TIME_MISMATCH: '#b91c1c', ACTIVITY_AFTER: '#b91c1c',
  PRESENCE_GAP: '#7c3aed', SYSTEM_BARRIER: '#0369a1',
};
const STATUS_LABEL: Record<string, string> = { APPROVED: '승인', PENDING: '대기', REJECTED: '반려' };

function kstHM(iso: string | null): string {
  if (!iso) return '-';
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(11, 16);
}
function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '-';
}

const CELL = { padding: '6px 8px', verticalAlign: 'top', textAlign: 'left' } as const;
const Td = ({ children }: { children?: ReactNode }) => <td style={CELL}>{children}</td>;
const Th = ({ children }: { children?: ReactNode }) => <th style={CELL}>{children}</th>;

export default function RecordConsistencyCard({ onAuthExpired }: { onAuthExpired: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyFlagged, setOnlyFlagged] = useState(true);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    apiFetch<Data>('/attendance/admin/field-check/record-consistency?days=45')
      .then((d) => { if (reqRef.current === id) setData(d); })
      .catch((e) => {
        if (reqRef.current !== id) return;
        if (isAuthExpiredError(e)) { onAuthExpired(); return; }
        setError(e instanceof Error ? e.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="card"><p style={{ color: '#b91c1c' }}>{error}</p></div>;
  if (!data) return <div className="card"><p>불러오는 중…</p></div>;
  const s = data.summary;
  const shown = onlyFlagged ? data.rows.filter((r) => r.flags.some((f) => f !== 'SYSTEM_BARRIER')) : data.rows;
  const rows = shown.slice(0, 150);
  const tiles: [string, string][] = [
    ['정정 요청', `${s.total}건`],
    ['직접 신청', `${s.manual}건`],
    ['기본값(출근+9시간) 추정', `${s.default9h}건 (${pct(s.default9h, s.manual)})`],
    ['사유 속 시각과 다름', `${s.reasonMismatch}건`],
    ['퇴근 이후 활동 있음', `${s.activityAfter}건`],
    ['위치 기록과 비교 가능', `${s.withPresence}건`],
    ['위치 기록과 1시간 넘게 차이', `${s.presenceGap}건`],
    ['위치 차단 반복(시스템 장벽)', `${s.systemBarrier}건`],
  ];
  const badge = (f: string) => ({
    display: 'inline-block' as const, margin: '0 8px 2px 0', fontSize: 11, color: FLAG_COLOR[f] ?? '#475569',
  });
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>기록 불일치 점검 (최근 {data.days}일)</h2>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        퇴근 정정 요청을 위치 기록·그날 마지막 활동·사유에 적은 시각과 대조해 확인할 건을 모았어요.
        판정이 아니라 확인 대상이며, 위치 기록은 앱 화면이 열려 있던 시간에만 남습니다.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 14px' }}>
        {tiles.map(([label, value]) => (
          <div key={label} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '8px 12px', minWidth: 150 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>
      <h3>직원별 (표시가 많은 순 · 상위 20명)</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr><Th>이름</Th><Th>정정</Th><Th>직접 신청</Th><Th>기본값 추정</Th><Th>사유 불일치</Th><Th>이후 활동</Th></tr>
          </thead>
          <tbody>
            {data.users.slice(0, 20).map((u) => (
              <tr key={u.userName} style={{ borderTop: '1px solid #e2e8f0' }}>
                <Td>{u.userName}</Td><Td>{u.total}</Td><Td>{u.manual}</Td>
                <Td>{u.default9h}</Td><Td>{u.mismatch}</Td><Td>{u.activityAfter}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ marginTop: 18 }}>정정 요청 목록</h3>
      <label style={{ fontSize: 13 }}>
        <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
        {' '}확인 표시가 있는 건만 보기 ({shown.length}건)
      </label>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 6 }}>
          <thead>
            <tr>
              <Th>근무일</Th><Th>이름</Th><Th>출근</Th><Th>신청 퇴근</Th>
              <Th>마지막 활동</Th><Th>위치 기록 대비</Th><Th>상태</Th><Th>표시</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                <Td>{r.workDate.slice(5)}</Td><Td>{r.userName}</Td>
                <Td>{kstHM(r.clockInAt)}</Td><Td>{kstHM(r.proposedClockOutAt)}</Td>
                <Td>{kstHM(r.lastActivityAt)}</Td>
                <Td>{r.presenceDiffMin == null ? '기록 없음' : `${r.presenceDiffMin > 0 ? '+' : ''}${r.presenceDiffMin}분`}</Td>
                <Td>{STATUS_LABEL[r.status] ?? r.status}</Td>
                <Td>
                  {r.flags.map((f) => (
                    <span key={f} style={badge(f)}>● {FLAG_LABEL[f] ?? f}</span>
                  ))}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p>표시할 건이 없습니다.</p>}
    </div>
  );
}
