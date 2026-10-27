import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, isAuthExpiredError } from '@/lib/api';
import LocationProposalsCard from '@/components/LocationProposalsCard';
import LocationFailuresCard from '@/components/LocationFailuresCard';
import LocationExceptionsCard from '@/components/LocationExceptionsCard';

/**
 * 방문지 점검 (2026-10-13) — 같은 장소에서 여러 명이 반복해서 위치 불일치가 나면, 직원 실수가 아니라 고객사 등록 좌표/미등록 방문지 문제일 수 있다.
 *  - "등록이 막힌 시도": 엄격 모드로 막힌 시도를 고객사별로 모아 여러 명이 반복해서 막힌 곳을 먼저 보여준다(좌표 없음).
 *  - "반복 불일치 장소": 불일치로 남은 위치를 300m 단위로 묶어 미등록 방문지 후보/등록 고객사 근처 어긋남을 가려낸다(약 100m 단위 지도 링크).
 * 관리자(HR_ADMIN/SYSTEM_ADMIN) 전용. 새 방문지 등록·좌표 수정은 "고객사 위치관리" 화면에서 한다.
 */
interface BlockedClient { clientName: string; count: number; userCount: number; userNames: string[]; medianDistanceMeters: number | null; suspectCoordinates: boolean }
interface Hotspot {
  kind: 'UNREGISTERED' | 'NEAR_OTHER_CLIENT'; count: number; userCount: number; userNames: string[]; firstDate: string; lastDate: string;
  statuses: string[]; chosenClients: { name: string; count: number }[]; nearestClient: { name: string; distanceMeters: number } | null; centerLat: number; centerLng: number;
}
interface HotspotsData {
  days: number; hotspots: Hotspot[]; hqAreaClusters: number; residentAreaClusters?: number; mismatchPointCount: number; capped: boolean;
  blocked: { clients: BlockedClient[]; hq: { count: number; userCount: number; medianDistanceMeters: number | null }; total: number; correctedFailed: number };
}

const STATUS_LABEL: Record<string, string> = {
  HQ_WORKING: '본사근무', CLIENT_WORK: '고객사작업', CLIENT_MEETING: '고객사미팅', NIGHT_WORK: '야간작업', WEEKEND_WORK: '주말작업',
  REMOTE_WORK: '재택', BUSINESS_TRIP: '출장', OTHER: '기타',
};

function fmtDist(m: number | null): string {
  if (m == null) return '-';
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}

export default function LocationHotspotsPanel({ onAuthExpired }: { onAuthExpired: () => void }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<HotspotsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    setData(null);
    setError(null);
    apiFetch<HotspotsData>(`/attendance/admin/field-check/location-hotspots?days=${days}`)
      .then((d) => { if (reqRef.current === id) setData(d); })
      .catch((e) => {
        if (reqRef.current !== id) return;
        if (isAuthExpiredError(e)) { onAuthExpired(); return; }
        setError(e instanceof Error ? e.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const repeated = (data?.blocked.clients ?? []).filter((c) => c.suspectCoordinates);
  const others = (data?.blocked.clients ?? []).filter((c) => !c.suspectCoordinates);

  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            최근
            <select style={{ margin: 0, width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7일</option>
              <option value={14}>14일</option>
              <option value={30}>30일</option>
            </select>
          </label>
          <span style={{ fontSize: 12.5, color: '#868e96' }}>
            같은 곳에서 여러 명이 반복해서 막히면 직원 실수보다 고객사 등록 좌표가 틀렸을 가능성이 큽니다. 이 화면은 관리자만 볼 수 있어요.
          </span>
        </div>
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      <LocationProposalsCard />

      <LocationFailuresCard days={days} onAuthExpired={onAuthExpired} />
      <LocationExceptionsCard days={days} onAuthExpired={onAuthExpired} />

      <div className="card">
        <h2>위치 때문에 등록이 막힌 시도 ({data?.blocked.total ?? 0}건)</h2>
        <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
          엄격 모드로 막힌 시도를 고객사별로 모았습니다(좌표는 저장하지 않고 고객사명·거리만 남깁니다). 지도로 위치를 보정했는데도 통과하지 못한 시도는 {data?.blocked.correctedFailed ?? 0}건입니다.
        </p>
        {!data && !error && <div className="board-empty">불러오는 중...</div>}
        {data && data.blocked.total === 0 && <div className="board-empty">이 기간에 위치 때문에 막힌 시도가 없습니다. (이 기록은 업데이트 이후부터 쌓입니다.)</div>}
        {data && data.blocked.total > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 700 }}>
              <thead><tr><th>고객사</th><th>막힌 횟수</th><th>직원 수</th><th>직원</th><th>거리(중앙값)</th><th>판단</th></tr></thead>
              <tbody>
                {[...repeated, ...others].map((c) => (
                  <tr key={c.clientName}>
                    <td>{c.clientName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{c.count}회</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{c.userCount}명</td>
                    <td>{c.userNames.join(', ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDist(c.medianDistanceMeters)}</td>
                    <td style={{ color: c.suspectCoordinates ? '#e8590c' : undefined }}>
                      {c.suspectCoordinates ? '여러 명이 반복 — 등록 좌표 확인 필요' : '개별 사례'}
                    </td>
                  </tr>
                ))}
                {data.blocked.hq.count > 0 && (
                  <tr>
                    <td>본사근무</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{data.blocked.hq.count}회</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{data.blocked.hq.userCount}명</td>
                    <td>-</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDist(data.blocked.hq.medianDistanceMeters)}</td>
                    <td>{data.blocked.hq.userCount >= 3 ? '여러 명 — 본사 좌표/반경 확인' : '개별 사례(대부분 본사 밖에서 누른 경우)'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {repeated.length > 0 && (
          <div className="notice-inline-orange" style={{ marginTop: 8 }}>
            ⚠️ {repeated.map((c) => c.clientName).join(', ')} — 여러 명이 반복해서 막혔어요. <Link href="/admin/clients">고객사 위치관리</Link>에서 등록된 주소·좌표가 실제 방문 위치와 맞는지 확인해 주세요.
          </div>
        )}
      </div>

      <div className="card">
        <h2>반복해서 불일치가 난 장소 ({data?.hotspots.length ?? 0}곳)</h2>
        <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
          위치 불일치로 남은 기록(관리자 전용 좌표, 보관 30일)을 300m 안끼리 묶어, 서로 다른 직원 2명 이상 또는 3건 이상 반복된 곳만 보여줍니다.
          본사 반경 안의 묶음 {data?.hqAreaClusters ?? 0}곳은 본사에서 한 작업을 현장으로 고른 경우라, 상주 직원이 상주지(배정 고객사) 근처에서 한 묶음 {data?.residentAreaClusters ?? 0}곳은 상주 근무지라 제외했어요.
        </p>
        {!data && !error && <div className="board-empty">불러오는 중...</div>}
        {data && data.hotspots.length === 0 && <div className="board-empty">반복해서 불일치가 난 장소가 없습니다. (분석한 불일치 기록 {data.mismatchPointCount}건)</div>}
        {data && data.hotspots.length > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 860 }}>
              <thead><tr><th>구분</th><th>기록</th><th>직원</th><th>기간</th><th>직원들이 고른 고객사</th><th>가장 가까운 등록 고객사</th><th>지도</th></tr></thead>
              <tbody>
                {data.hotspots.map((h, i) => (
                  <tr key={`${h.centerLat},${h.centerLng},${i}`}>
                    <td style={{ whiteSpace: 'nowrap', color: h.kind === 'UNREGISTERED' ? '#e8590c' : undefined }}>
                      {h.kind === 'UNREGISTERED' ? '미등록 방문지 후보' : '등록 고객사 근처인데 어긋남'}
                      {h.statuses.length > 0 && h.statuses.every((st) => st === 'HQ_WORKING') && (
                        <div style={{ fontSize: 12, color: '#868e96', whiteSpace: 'normal' }}>전부 &quot;본사근무&quot;로 등록 — 고객사 문제가 아니라 근무 형태를 잘못 골랐을 수 있어요. 직원에게 근무지를 확인하세요.</div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{h.count}건 ({h.statuses.map((s) => STATUS_LABEL[s] ?? s).join('·')})</td>
                    <td>{h.userCount}명 — {h.userNames.join(', ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{h.firstDate === h.lastDate ? h.firstDate : `${h.firstDate} ~ ${h.lastDate}`}</td>
                    <td>{h.chosenClients.length > 0 ? h.chosenClients.map((c) => `${c.name}(${c.count})`).join(', ') : '-'}</td>
                    <td>{h.nearestClient ? `${h.nearestClient.name} (${fmtDist(h.nearestClient.distanceMeters)})` : '없음'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <a href={`https://map.kakao.com/link/map/방문지후보,${h.centerLat},${h.centerLng}`} target="_blank" rel="noreferrer">지도 보기</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12.5, color: '#868e96', marginBottom: 0 }}>
          판단 방법: &quot;미등록 방문지 후보&quot;는 <Link href="/admin/clients">고객사 위치관리</Link>에서 새 고객사(또는 기존 고객사의 새 지점)로 등록하고,
          &quot;등록 고객사 근처인데 어긋남&quot;은 그 고객사의 등록 좌표를 바로잡으세요. 지도 위치는 약 100m 단위의 대략값입니다.
        </p>
        {data?.capped && <div className="notice-inline-orange">⚠️ 일부 기록이 잘렸어요. 기간을 줄여서 보세요.</div>}
      </div>
    </>
  );
}
