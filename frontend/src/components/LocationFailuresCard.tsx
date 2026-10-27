import { useEffect, useRef, useState } from 'react';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

/**
 * 위치 확인 실패 기록 (2026-10-15) — 위치 문제로 거절된 출근/상태 등록 시도를 기기(PC/휴대폰)·오류 종류·직원별로 보여준다.
 * "출근이 여러 번 안 됐다"는 신고의 원인을 직원에게 되묻지 않고 확인하기 위한 화면이다(좌표는 기록하지 않는다).
 */
type Device = 'PC' | 'MOBILE' | 'UNKNOWN';
interface FailuresData {
  days: number; total: number; userCount: number; capped: boolean;
  byDevice: { device: Device; count: number; userCount: number }[];
  byCode: { code: string; label: string; count: number; userCount: number }[];
  users: { userName: string; count: number; lastAt: string; devices: Device[]; codes: string[]; medianAccuracyMeters: number | null }[];
  recent: { at: string; userName: string; endpoint: 'CLOCK_IN' | 'STATUS'; status: string | null; label: string; accuracyMeters: number | null; hasLocation: boolean; locationStatus: string | null; device: Device }[];
}

const DEVICE_LABEL: Record<Device, string> = { PC: 'PC', MOBILE: '휴대폰', UNKNOWN: '알 수 없음' };
const ENDPOINT_LABEL = { CLOCK_IN: '출근 버튼', STATUS: '상태 등록' } as const;
const STATUS_LABEL: Record<string, string> = {
  HQ_WORKING: '본사근무', CLIENT_WORK: '고객사작업', CLIENT_MEETING: '고객사미팅', NIGHT_WORK: '야간작업', WEEKEND_WORK: '주말작업',
  REMOTE: '재택', BUSINESS_TRIP: '출장', RESIDENT_ONSITE: '고객사상주', MOVING: '이동중',
};
const LOC_STATUS_LABEL: Record<string, string> = {
  OK: '위치 확인됨', PERMISSION_DENIED: '위치 권한 거부', POSITION_UNAVAILABLE: '위치를 못 구함', TIMEOUT: '시간 초과', UNSUPPORTED: '지원 안 됨', NO_CONSENT: '위치 동의 없음',
};

function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}
function fmtAcc(m: number | null): string {
  if (m == null) return '-';
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}

export default function LocationFailuresCard({ days, onAuthExpired }: { days: number; onAuthExpired: () => void }) {
  const [data, setData] = useState<FailuresData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    setData(null);
    setError(null);
    apiFetch<FailuresData>(`/attendance/admin/field-check/location-failures?days=${days}`)
      .then((d) => { if (reqRef.current === id) setData(d); })
      .catch((e) => {
        if (reqRef.current !== id) return;
        if (isAuthExpiredError(e)) { onAuthExpired(); return; }
        setError(e instanceof Error ? e.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const pc = data?.byDevice.find((d) => d.device === 'PC');
  const pcHeavy = Boolean(data && data.total >= 3 && pc && pc.count * 2 >= data.total);

  return (
    <div className="card" data-testid="location-failures">
      <h2>위치 확인 실패 기록 ({data?.total ?? 0}건 · {data?.userCount ?? 0}명)</h2>
      <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
        위치 문제로 거절된 &quot;출근&quot; 버튼과 상태 등록 시도입니다(좌표·IP는 저장하지 않고 기기 종류·오류 종류·GPS 오차만 남깁니다). 이 기록은 업데이트 이후부터 쌓입니다.
        직원이 &quot;여러 번 눌러도 안 됐다&quot;고 하면 여기서 그 시각의 오류 종류를 확인하세요.
      </p>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="board-empty">불러오는 중...</div>}
      {data && data.total === 0 && <div className="board-empty">이 기간에 위치 때문에 거절된 출근·등록 시도가 없습니다.</div>}
      {data && data.total > 0 && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            기기별: {data.byDevice.map((d) => `${DEVICE_LABEL[d.device]} ${d.count}건(${d.userCount}명)`).join(' · ')}
          </div>
          {pcHeavy && (
            <div className="notice-inline-orange" style={{ marginBottom: 8 }}>
              ⚠️ PC 접속에서 실패가 많아요. PC는 GPS가 없어 위치가 부정확할 수 있습니다. 직원에게 Wi-Fi 켜기·VPN 끄기·휴대폰으로 등록하기를 안내해 주세요.
            </div>
          )}
          <div className="table-scroll">
            <table style={{ minWidth: 520 }}>
              <thead><tr><th>오류 종류</th><th>횟수</th><th>직원 수</th></tr></thead>
              <tbody>
                {data.byCode.map((c) => (
                  <tr key={c.code}><td>{c.label}</td><td style={{ whiteSpace: 'nowrap' }}>{c.count}회</td><td style={{ whiteSpace: 'nowrap' }}>{c.userCount}명</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>직원별</h3>
          <div className="table-scroll">
            <table style={{ minWidth: 700 }}>
              <thead><tr><th>직원</th><th>횟수</th><th>기기</th><th>오류 종류</th><th>GPS 오차(중앙값)</th><th>마지막 시도</th></tr></thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.userName}>
                    <td>{u.userName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{u.count}회</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{u.devices.map((d) => DEVICE_LABEL[d]).join('·')}</td>
                    <td>{u.codes.join(', ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtAcc(u.medianAccuracyMeters)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{kst(u.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>최근 시도</h3>
          <div className="table-scroll">
            <table style={{ minWidth: 760 }}>
              <thead><tr><th>시각(한국)</th><th>직원</th><th>요청</th><th>오류 종류</th><th>GPS 오차</th><th>위치 상태</th><th>기기</th></tr></thead>
              <tbody>
                {data.recent.map((r, i) => (
                  <tr key={`${r.at}-${r.userName}-${i}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{kst(r.at)}</td>
                    <td>{r.userName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{ENDPOINT_LABEL[r.endpoint]}{r.status ? ` (${STATUS_LABEL[r.status] ?? r.status})` : ''}</td>
                    <td>{r.label}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtAcc(r.accuracyMeters)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.locationStatus ? (LOC_STATUS_LABEL[r.locationStatus] ?? r.locationStatus) : r.hasLocation ? '위치 전송됨' : '위치 없음'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{DEVICE_LABEL[r.device]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data?.capped && <div className="notice-inline-orange" style={{ marginTop: 8 }}>⚠️ 일부 기록이 잘렸어요. 기간을 줄여서 보세요.</div>}
    </div>
  );
}
