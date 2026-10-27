import { useEffect, useRef, useState } from 'react';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

/**
 * 내 현재 위치로 등록한 기록 (2026-10-27) — GPS·기지국 오차 등으로 위치를 못 맞춘 엔지니어가 사유와 현재 위치를 적고 등록한 건을
 * 직원·기기·OS·통신 환경별로 모아 보여준다. "왜 이 사람들만 반복되는지"를 기기/환경에서 찾기 위한 화면이다(좌표는 보여주지 않는다).
 */
interface ExcData {
  days: number; total: number; userCount: number;
  byDevice: { device: string; count: number; userCount: number }[];
  byConnection: { type: string; count: number }[];
  users: { userName: string; count: number; lastAt: string; devices: string[]; osList: string[]; browsers: string[]; connections: string[]; medianAccuracyMeters: number | null; medianDistanceMeters: number | null }[];
  recent: { at: string; userName: string; status: string; clientName: string; distanceMeters: number | null; accuracyMeters: number | null; address: string; reason: string; device: string; os: string; browser: string; connection: string; captureStatus: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  HQ_WORKING: '본사근무', CLIENT_WORK: '고객사작업', CLIENT_MEETING: '고객사미팅', NIGHT_WORK: '야간작업', WEEKEND_WORK: '주말작업',
  REMOTE: '재택', BUSINESS_TRIP: '출장', RESIDENT_ONSITE: '고객사상주', MOVING: '이동중',
};

function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}
function fmtM(m: number | null): string {
  if (m == null) return '-';
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}

export default function LocationExceptionsCard({ days, onAuthExpired }: { days: number; onAuthExpired: () => void }) {
  const [data, setData] = useState<ExcData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    setData(null);
    setError(null);
    apiFetch<ExcData>(`/attendance/admin/field-check/location-exceptions?days=${Math.max(days, 30)}`)
      .then((d) => { if (reqRef.current === id) setData(d); })
      .catch((e) => {
        if (reqRef.current !== id) return;
        if (isAuthExpiredError(e)) { onAuthExpired(); return; }
        setError(e instanceof Error ? e.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  return (
    <div className="card" data-testid="location-exceptions">
      <h2>내 현재 위치로 등록한 기록 ({data?.total ?? 0}건 · {data?.userCount ?? 0}명)</h2>
      <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
        GPS·기지국 오차로 위치를 못 맞춘 엔지니어가 사유와 현재 위치를 적고 등록한 건입니다(최근 {data?.days ?? Math.max(days, 30)}일). 같은 직원이나 같은 기기에서 반복되면
        기기 설정·통신 환경 점검이나 고객사 좌표 보정 대상입니다. 좌표는 보여주지 않습니다.
      </p>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="board-empty">불러오는 중...</div>}
      {data && data.total === 0 && <div className="board-empty">이 기간에 &quot;내 현재 위치로 등록&quot;한 기록이 없습니다.</div>}
      {data && data.total > 0 && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            기기별: {data.byDevice.map((d) => `${d.device} ${d.count}건(${d.userCount}명)`).join(' · ')}
          </div>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            통신 종류별: {data.byConnection.map((c) => `${c.type} ${c.count}건`).join(' · ')}
          </div>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>직원별 (반복 순)</h3>
          <div className="table-scroll">
            <table style={{ minWidth: 760 }}>
              <thead><tr><th>직원</th><th>횟수</th><th>기기</th><th>OS</th><th>브라우저</th><th>통신</th><th>GPS 오차(중앙값)</th><th>고객사와 거리(중앙값)</th><th>마지막</th></tr></thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.userName} style={u.count >= 3 ? { background: 'rgba(245,158,11,0.10)' } : undefined}>
                    <td>{u.userName}{u.count >= 3 ? ' ⚠️' : ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{u.count}회</td>
                    <td>{u.devices.join(', ')}</td>
                    <td>{u.osList.join(', ')}</td>
                    <td>{u.browsers.join(', ')}</td>
                    <td>{u.connections.join(', ') || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtM(u.medianAccuracyMeters)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtM(u.medianDistanceMeters)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{kst(u.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>최근 등록 (최대 100건)</h3>
          <div className="table-scroll">
            <table style={{ minWidth: 860 }}>
              <thead><tr><th>시각(한국)</th><th>직원</th><th>상태</th><th>고객사</th><th>거리</th><th>GPS 오차</th><th>적은 사유·현재 위치</th><th>기기/OS</th></tr></thead>
              <tbody>
                {data.recent.map((r, i) => (
                  <tr key={`${r.at}-${r.userName}-${i}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{kst(r.at)}</td>
                    <td>{r.userName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{STATUS_LABEL[r.status] ?? r.status}</td>
                    <td>{r.clientName || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtM(r.distanceMeters)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtM(r.accuracyMeters)}</td>
                    <td>{r.reason}{r.address ? ` (자동 주소: ${r.address})` : ''}</td>
                    <td>{r.device}{r.os ? ` · ${r.os}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
