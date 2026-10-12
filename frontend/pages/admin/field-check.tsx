import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, isAuthExpiredError } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

/**
 * 현장 기록 점검 (2026-10-11).
 * "출퇴근 · 고객사 도착 위치/시각 · 작업내용 · 담당자 · 소요시간은 모두 빠짐없이 기록되어야 한다"는 원칙이 현장에서
 * 잘 지켜지는지 관리자가 한 곳에서 점검한다. 데이터는 지우지 않고 기간으로만 걸러서 본다.
 *  - 위치 예외: 등록된 고객사 위치와 달랐거나, GPS 정확도가 낮았거나, 위치를 못 구해 사유로 등록한 건
 *  - 퇴근 위치: 본사/고객사가 아닌 곳에서 퇴근했거나 위치 없이 퇴근한 건
 *  - 자동 마무리: 직원이 끝내지 않아 시스템/관리자가 종료시각을 채운 건
 *  - 입력 누락: 작업내용/담당자가 비어 있는 건
 *  - 미종료 작업: 종료시각 없이 남은 과거 작업(추정 종료시각 미리보기 → 적용). 10시간을 넘는 건은 자동 적용하지 않는다.
 *  - 퇴근·일지 점검(2026-10-12): 퇴근 기록이 비어 있는 지난 근무일(+정정 신청 상태)과, 퇴근은 됐는데 업무일지가 없는 날. 조회 전용.
 * 좌표는 화면에도 서버 응답에도 없다(거리·정확도·사유만).
 */

type Tab = 'location' | 'clockout' | 'auto' | 'incomplete' | 'open' | 'gaps';

interface LocationRow { id: string; userName: string; status: string; changedAt: string; note: string | null; locationMatch: boolean | null; distanceMeters: number | null; accuracyMeters: number | null; siteType: string | null }
interface ClockOutRow { id: string; userName: string; workDate: string; clockOutAt: string | null; place: string | null; locationMatch: boolean | null; distanceMeters: number | null; note: string | null }
interface AutoRow { id: string; userName: string; workDate: string; clientName: string | null; startTime: string; endTime: string | null; minutes: number | null; closedBy: string | null }
interface IncompleteRow { id: string; userName: string; workDate: string; clientName: string | null; status: string | null; missingDescription: boolean; missingContact: boolean }
interface ExceptionsData { locationExceptions: LocationRow[]; clockOutExceptions: ClockOutRow[]; autoClosed: AutoRow[]; incomplete: IncompleteRow[]; capped: boolean }
interface OpenRow { id: string; userName: string; workDate: string; clientName: string | null; workType: string | null; sourceStatus: string | null; startTime: string; hasDescription: boolean; estimatedEnd: string | null; minutes: number | null; verdict: 'OK' | 'NO_NEXT' | 'TOO_LONG' | 'INVALID' }
interface OpenData { items: OpenRow[]; capped: boolean; applicable: number }
interface UnclosedRow { id: string; userName: string; workDate: string; clockInAt: string | null; dataSource: string; hasWorkLog: boolean; requestStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'; requestedAt: string | null }
interface NoLogRow { id: string; userName: string; workDate: string; clockOutAt: string | null; isCorrected: boolean }
interface GapsData { unclosed: UnclosedRow[]; noLog: NoLogRow[]; capped: boolean }

const STATUS_LABEL: Record<string, string> = {
  CLIENT_WORK: '고객사작업', CLIENT_MEETING: '고객사미팅', WEEKEND_WORK: '주말작업', NIGHT_WORK: '야간작업', HQ_WORKING: '본사근무',
  REMOTE: '재택', RESIDENT_ONSITE: '고객사상주', MOVING: '이동중', BUSINESS_TRIP: '출장',
};
const CLOSED_BY_LABEL: Record<string, string> = {
  AUTO_AWAY: '고객사에서 30분 이상 벗어남', AUTO_STATUS_CHANGE: '다른 상태로 변경하며 마무리', AUTO_CLOCKOUT: '퇴근하며 마무리', ADMIN_ESTIMATE: '관리자 추정 마무리',
};
const PLACE_LABEL: Record<string, string> = { HQ: '본사', CLIENT: '고객사', OTHER: '그 외 장소' };
const REQUEST_STATUS_LABEL: Record<string, string> = {
  NONE: '신청 안 함', PENDING: '승인 대기중', APPROVED: '승인됨(퇴근 반영 대기)', REJECTED: '반려됨(다시 신청 필요)',
};
const VERDICT_LABEL: Record<string, string> = { OK: '적용 가능', NO_NEXT: '근거 없음(다음 기록 없음)', TOO_LONG: '10시간 초과(직접 확인)', INVALID: '시간 이상' };

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function kstTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
}
function minutesLabel(m: number | null): string {
  if (m == null) return '-';
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
function locationReason(r: LocationRow): string {
  const tags: string[] = [];
  if (r.locationMatch === false) tags.push(`등록 위치와 다름${r.distanceMeters != null ? ` (약 ${r.distanceMeters}m)` : ''}`);
  if (r.note?.includes('[GPS 정확도 낮음')) tags.push(`GPS 정확도 낮음${r.accuracyMeters != null ? ` (오차 약 ${Math.round(r.accuracyMeters)}m)` : ''}`);
  // 2026-10-12: 직원이 지도에서 직접 위치를 확인·보정해 "일치"로 등록한 건 — 본인 확인이므로 근거(측정 오차)와 함께 보여준다.
  if (r.note?.includes('[GPS 위치 보정')) tags.push(`지도로 직접 확인함${r.accuracyMeters != null ? ` (GPS 오차 약 ${Math.round(r.accuracyMeters)}m)` : ''}`);
  const failure = r.note?.match(/\[위치 확인 불가 — 사유: ([^\]]*)\]/);
  if (r.note?.includes('[위치 확인 불가')) tags.push(`위치 확인 불가${failure ? ` — ${failure[1]}` : ''}`);
  return tags.join(' · ') || '-';
}

export default function AdminFieldCheckPage() {
  const router = useRouter();
  const today = ymd(new Date(Date.now() + 9 * 3600_000));
  const [tab, setTab] = useState<Tab>('location');
  const [from, setFrom] = useState('2026-10-01');
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ExceptionsData | null>(null);
  const [openData, setOpenData] = useState<OpenData | null>(null);
  const [gapsData, setGapsData] = useState<GapsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);

  function handleErr(err: unknown) {
    if (isAuthExpiredError(err)) { router.push('/login'); return; }
    setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
  }

  function load() {
    const id = ++requestRef.current;
    setError(null);
    const qs = `from=${from}&to=${to}`;
    apiFetch<ExceptionsData>(`/attendance/admin/field-check/exceptions?${qs}`)
      .then((d) => { if (requestRef.current === id) setData(d); })
      .catch((e) => { if (requestRef.current === id) handleErr(e); });
    apiFetch<OpenData>(`/attendance/admin/field-check/open-efforts?${qs}`)
      .then((d) => { if (requestRef.current === id) { setOpenData(d); setSelected(new Set()); setConfirming(false); } })
      .catch((e) => { if (requestRef.current === id) handleErr(e); });
    apiFetch<GapsData>(`/attendance/admin/field-check/attendance-gaps?${qs}`)
      .then((d) => { if (requestRef.current === id) setGapsData(d); })
      .catch((e) => { if (requestRef.current === id) handleErr(e); });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [from, to]);

  const applicableIds = useMemo(() => (openData?.items ?? []).filter((i) => i.verdict === 'OK').map((i) => i.id), [openData]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  async function applySelected() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setApplyMsg(null);
    try {
      const res = await apiFetch<{ applied: number; skipped: { id: string; reason: string }[] }>('/attendance/admin/field-check/open-efforts/apply', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected] }),
      });
      setApplyMsg(`${res.applied}건을 마무리했어요.${res.skipped.length > 0 ? ` (${res.skipped.length}건은 조건이 맞지 않아 건너뜀)` : ''}`);
      load();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const counts = {
    location: data?.locationExceptions.length ?? 0,
    clockout: data?.clockOutExceptions.length ?? 0,
    auto: data?.autoClosed.length ?? 0,
    incomplete: data?.incomplete.length ?? 0,
    open: openData?.items.length ?? 0,
    gaps: (gapsData?.unclosed.length ?? 0) + (gapsData?.noLog.length ?? 0),
  };
  const TABS: { key: Tab; label: string }[] = [
    { key: 'location', label: '위치 예외' },
    { key: 'clockout', label: '퇴근 위치' },
    { key: 'auto', label: '자동 마무리' },
    { key: 'incomplete', label: '입력 누락' },
    { key: 'open', label: '미종료 작업' },
    { key: 'gaps', label: '퇴근·일지 점검' },
  ];

  return (
    <div className="admin-shell">
      <AdminHeader title="현장 기록 점검" />
      <p className="admin-page-subtitle">
        출퇴근 위치, 고객사 도착 위치·시각, 작업내용, 고객사 담당자, 작업시간이 빠짐없이 기록되는지 점검합니다. 기록은 지우지 않고 기간으로만 걸러 봅니다.
        화면에는 좌표가 표시되지 않고 거리·정확도·사유만 보입니다.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            기간
            <input type="date" style={{ margin: 0, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
            ~
            <input type="date" style={{ margin: 0, width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {TABS.map((t) => (
              <button key={t.key} type="button" className={tab === t.key ? undefined : 'secondary'} style={{ width: 'auto', margin: 0 }} onClick={() => setTab(t.key)}>
                {t.label} ({counts[t.key]})
              </button>
            ))}
          </div>
        </div>
        {data?.capped && <div className="notice-inline-orange" style={{ marginTop: 8 }}>⚠️ 일부 목록이 300건에서 잘렸어요. 기간을 줄여서 보세요.</div>}
      </div>

      {tab === 'location' && (
        <div className="card">
          <h2>위치 예외 ({counts.location}건)</h2>
          {!data && <div className="board-empty">불러오는 중...</div>}
          {data && counts.location === 0 && <div className="board-empty">해당 기간에 위치 예외가 없습니다.</div>}
          {data && counts.location > 0 && (
            <div className="table-scroll">
              <table style={{ minWidth: 760 }}>
                <thead><tr><th>시각</th><th>이름</th><th>상태</th><th>사유</th></tr></thead>
                <tbody>
                  {data.locationExceptions.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.changedAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{STATUS_LABEL[r.status] ?? r.status}</td>
                      <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{locationReason(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'clockout' && (
        <div className="card">
          <h2>퇴근 위치 점검 ({counts.clockout}건)</h2>
          {!data && <div className="board-empty">불러오는 중...</div>}
          {data && counts.clockout === 0 && <div className="board-empty">해당 기간에 점검할 퇴근 위치 기록이 없습니다.</div>}
          {data && counts.clockout > 0 && (
            <div className="table-scroll">
              <table style={{ minWidth: 760 }}>
                <thead><tr><th>날짜</th><th>이름</th><th>퇴근</th><th>퇴근 장소</th><th>내용</th></tr></thead>
                <tbody>
                  {data.clockOutExceptions.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.workDate}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.clockOutAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.place ? PLACE_LABEL[r.place] ?? r.place : '확인 안 됨'}</td>
                      <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                        {r.locationMatch === false ? `기대 장소와 다름${r.distanceMeters != null ? ` (약 ${r.distanceMeters}m)` : ''}` : ''}
                        {r.note ? `${r.locationMatch === false ? ' · ' : ''}${r.note}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'auto' && (
        <div className="card">
          <h2>자동 마무리된 작업 ({counts.auto}건)</h2>
          <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>직원이 끝내지 않아 시스템(또는 관리자)이 종료시각을 채운 건입니다. 실제와 다르면 해당 직원에게 정정을 요청하세요.</p>
          {!data && <div className="board-empty">불러오는 중...</div>}
          {data && counts.auto === 0 && <div className="board-empty">해당 기간에 자동 마무리된 작업이 없습니다.</div>}
          {data && counts.auto > 0 && (
            <div className="table-scroll">
              <table style={{ minWidth: 760 }}>
                <thead><tr><th>날짜</th><th>이름</th><th>고객사</th><th>시작</th><th>종료</th><th>소요</th><th>마무리 방식</th></tr></thead>
                <tbody>
                  {data.autoClosed.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.workDate}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                      <td>{r.clientName ?? '-'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.startTime)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.endTime)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{minutesLabel(r.minutes)}</td>
                      <td>{r.closedBy ? CLOSED_BY_LABEL[r.closedBy] ?? r.closedBy : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'incomplete' && (
        <div className="card">
          <h2>입력 누락 ({counts.incomplete}건)</h2>
          <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>작업내용이 비어 있거나, 담당자 입력이 시작된 날(10/12) 이후 담당자가 없는 고객사작업·미팅입니다. 10/12 이전 기록의 담당자 누락은 표시하지 않습니다.</p>
          {!data && <div className="board-empty">불러오는 중...</div>}
          {data && counts.incomplete === 0 && <div className="board-empty">누락된 기록이 없습니다.</div>}
          {data && counts.incomplete > 0 && (
            <div className="table-scroll">
              <table style={{ minWidth: 640 }}>
                <thead><tr><th>날짜</th><th>이름</th><th>구분</th><th>고객사</th><th>누락 항목</th></tr></thead>
                <tbody>
                  {data.incomplete.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.workDate}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.status ? STATUS_LABEL[r.status] ?? r.status : '-'}</td>
                      <td>{r.clientName ?? '-'}</td>
                      <td style={{ color: '#e8590c' }}>{[r.missingDescription ? '작업내용' : null, r.missingContact ? '고객사 담당자' : null].filter(Boolean).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'gaps' && (
        <>
          <div className="card">
            <h2>퇴근 기록이 비어 있는 지난 근무일 ({gapsData?.unclosed.length ?? 0}건)</h2>
            <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
              출근만 찍고 퇴근 기록 없이 날짜가 넘어간 건입니다(주로 오후 출근자). 시스템이 퇴근시각을 임의로 채우지 않으며, 본인에게 푸시 알림이 가고 본인이 &quot;지난 근무일 퇴근 정정&quot;을 신청해야 합니다.
              승인 대기중인 건은 팀장/인사 승인이 필요합니다.
            </p>
            {!gapsData && <div className="board-empty">불러오는 중...</div>}
            {gapsData && gapsData.unclosed.length === 0 && <div className="board-empty">해당 기간에 퇴근이 비어 있는 지난 근무일이 없습니다.</div>}
            {gapsData && gapsData.unclosed.length > 0 && (
              <div className="table-scroll">
                <table style={{ minWidth: 700 }}>
                  <thead><tr><th>날짜</th><th>이름</th><th>출근</th><th>정정 신청</th><th>업무일지</th></tr></thead>
                  <tbody>
                    {gapsData.unclosed.map((r) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.workDate}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.clockInAt)}</td>
                        <td style={{ whiteSpace: 'nowrap', color: r.requestStatus === 'PENDING' ? undefined : '#e8590c' }}>{REQUEST_STATUS_LABEL[r.requestStatus] ?? r.requestStatus}</td>
                        <td style={{ whiteSpace: 'nowrap', color: r.hasWorkLog ? undefined : '#e8590c' }}>{r.hasWorkLog ? '있음' : '없음'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card">
            <h2>퇴근은 했는데 업무일지가 없는 날 ({gapsData?.noLog.length ?? 0}건)</h2>
            <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
              앱에서 퇴근 처리됐지만 그 날의 업무일지가 없는 기록입니다(다우오피스 동기화분은 제외). 이 기능 적용 전에 정정으로 닫힌 날이 여기에 나타날 수 있어요.
            </p>
            {!gapsData && <div className="board-empty">불러오는 중...</div>}
            {gapsData && gapsData.noLog.length === 0 && <div className="board-empty">일지가 빠진 날이 없습니다.</div>}
            {gapsData && gapsData.noLog.length > 0 && (
              <div className="table-scroll">
                <table style={{ minWidth: 560 }}>
                  <thead><tr><th>날짜</th><th>이름</th><th>퇴근</th><th>구분</th></tr></thead>
                  <tbody>
                    {gapsData.noLog.map((r) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.workDate}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.clockOutAt)}</td>
                        <td>{r.isCorrected ? '퇴근 정정으로 마감' : '일반 퇴근'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {gapsData?.capped && <div className="notice-inline-orange">⚠️ 일부 목록이 잘렸어요. 기간을 줄여서 보세요.</div>}
        </>
      )}

      {tab === 'open' && (
        <div className="card">
          <h2>종료시각 없이 남은 과거 작업 ({counts.open}건)</h2>
          <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
            작업을 끝내는 입력이 없어 공수가 비어 있는 과거 기록입니다. 그 뒤 처음 일어난 일(다음 상태 변경 또는 다음 작업 시작)을 종료시각으로 추정합니다.
            추정이 10시간을 넘거나 근거가 없으면 자동 적용 대상에서 빠지며, 선택해서 적용하면 &quot;관리자 추정 마무리&quot;로 기록되고 감사 기록이 남습니다. 적용 전에는 아무것도 바뀌지 않습니다.
          </p>
          {applyMsg && <div className="notice-inline-orange" style={{ marginBottom: 8 }}>{applyMsg}</div>}
          {!openData && <div className="board-empty">불러오는 중...</div>}
          {openData && counts.open === 0 && <div className="board-empty">종료시각 없이 남은 과거 작업이 없습니다.</div>}
          {openData && counts.open > 0 && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <button type="button" className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => { setSelected(new Set(applicableIds)); setConfirming(false); }}>
                  적용 가능한 {applicableIds.length}건 모두 선택
                </button>
                <button type="button" className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => { setSelected(new Set()); setConfirming(false); }}>
                  선택 해제
                </button>
                {!confirming ? (
                  <button type="button" style={{ width: 'auto', margin: 0 }} disabled={selected.size === 0 || busy} onClick={() => setConfirming(true)}>
                    선택한 {selected.size}건 마무리…
                  </button>
                ) : (
                  <>
                    <span style={{ fontSize: 13 }}>정말 {selected.size}건의 종료시각을 추정값으로 채울까요?</span>
                    <button type="button" style={{ width: 'auto', margin: 0 }} disabled={busy} onClick={applySelected}>네, 적용합니다</button>
                    <button type="button" className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setConfirming(false)}>아니요</button>
                  </>
                )}
              </div>
              {openData.capped && <div className="notice-inline-orange" style={{ marginBottom: 8 }}>⚠️ 300건에서 잘렸어요. 기간을 줄이거나, 적용 후 다시 조회하세요.</div>}
              <div className="table-scroll">
                <table style={{ minWidth: 900 }}>
                  <thead><tr><th></th><th>날짜</th><th>이름</th><th>구분</th><th>고객사</th><th>시작</th><th>추정 종료</th><th>추정 시간</th><th>판정</th></tr></thead>
                  <tbody>
                    {openData.items.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <input
                            type="checkbox"
                            style={{ margin: 0, width: 'auto' }}
                            disabled={r.verdict !== 'OK'}
                            checked={selected.has(r.id)}
                            onChange={() => toggle(r.id)}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.workDate}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.sourceStatus ? STATUS_LABEL[r.sourceStatus] ?? r.sourceStatus : '-'}</td>
                        <td>{r.clientName ?? '-'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.startTime)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{kstTime(r.estimatedEnd)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{minutesLabel(r.minutes)}</td>
                        <td style={{ color: r.verdict === 'OK' ? undefined : '#e8590c' }}>{VERDICT_LABEL[r.verdict]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
