import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

/**
 * 일일업무일지 관리자 화면 (3단계).
 * 2026-09-26: 김형태 대표이사 요청 — "매일 업무 마감을 일일업무일지로" 진행한 뒤, 관리자가 직원별
 * 제출 내역을 한눈에 보고 주간/월간으로 얼마나 쌓였는지 확인할 수 있어야 한다. night-work-mail
 * 관리자 화면과 같은 패턴(필터 카드 + 집계 카드 + 목록 표)으로 만들었다.
 */

interface RowData {
  id: string;
  workDate: string;
  userName: string;
  employeeNo: string;
  departmentName: string | null;
  formType: 'SIMPLE' | 'DETAILED';
  workTypeSnapshot: string | null;
  visitedClients: string | null;
  workContent: string | null;
  issues: string;
  followUp: string | null;
  tomorrowPlan: string;
  supportRequest: string | null;
  totalWorkedMinutes: number | null;
  actualEffortMinutes: number | null;
  // 2026-09-29: "미등록 공백시간" — 마지막 작업 종료 후 새 상태등록 없이 퇴근한 경우의 공백(분)과
  // 본인이 남긴 사유. 없으면 둘 다 null.
  unloggedGapMinutes: number | null;
  unloggedGapReason: string | null;
  submittedAt: string;
  // 2026-09-29: 위치이탈 자동감지(고객사에서 이탈 후 30분) 이벤트 — 등록된 고객사 위치와 이탈 당시
  // 위치 사이 거리로 실제 작업완료 시점을 추정하는 데 쓴다. 미등록 공백 사유와는 별개 정보라 화면도
  // 별도 블록으로 보여준다. 없으면 빈 배열.
  departureEvents: { at: string; locationMatch: boolean | null; locationDistanceMeters: number | null }[];
}

interface SummaryData {
  total: number;
  simpleCount: number;
  detailedCount: number;
  unloggedGapCount: number;
  departureDetectedCount: number;
  byUser: { name: string; count: number; simpleCount: number; detailedCount: number; avgMinutes: number }[];
  byClient: { name: string; count: number }[];
}

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function firstDayOfThisMonth(): string {
  const now = new Date();
  return toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
}

function hoursLabel(minutes: number | null): string {
  if (minutes == null) return '-';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
}

export default function AdminDailyWorkLogPage() {
  const router = useRouter();
  const [from, setFrom] = useState(firstDayOfThisMonth());
  const [to, setTo] = useState(toDateInputValue(new Date()));
  const [formType, setFormType] = useState<'' | 'SIMPLE' | 'DETAILED'>('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<RowData[] | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function buildQuery(): string {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (formType) params.set('formType', formType);
    if (q.trim()) params.set('q', q.trim());
    return params.toString();
  }

  function load() {
    const qs = buildQuery();
    apiFetch<RowData[]>(`/daily-work-log/admin/list?${qs}`)
      .then(setRows)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
    apiFetch<SummaryData>(`/daily-work-log/admin/summary?${qs}`)
      .then(setSummary)
      .catch(() => {});
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [from, to, formType]);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    load();
  }

  return (
    <div className="admin-shell">
      <AdminHeader title="일일업무일지" />
      <p className="admin-page-subtitle">
        퇴근 시 직원이 마감한 &quot;이슈/특이사항&quot;·&quot;내일 예정 업무&quot;와, 오늘 근무형태에 따라 자동으로
        모인 방문 고객사·작업내용을 한눈에 봅니다. 상세형은 고객사/현장 근무일에 자동 판정된 항목입니다.
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
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" className={formType === '' ? undefined : 'secondary'} style={{ width: 'auto', margin: 0 }} onClick={() => setFormType('')}>
              전체
            </button>
            <button type="button" className={formType === 'SIMPLE' ? undefined : 'secondary'} style={{ width: 'auto', margin: 0 }} onClick={() => setFormType('SIMPLE')}>
              간단형
            </button>
            <button type="button" className={formType === 'DETAILED' ? undefined : 'secondary'} style={{ width: 'auto', margin: 0 }} onClick={() => setFormType('DETAILED')}>
              상세형
            </button>
          </div>
          <form onSubmit={onSearchSubmit} style={{ display: 'flex', gap: 4 }}>
            <input
              style={{ margin: 0, width: 260 }}
              placeholder="이름 또는 고객사·작업내용 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="submit" className="secondary" style={{ width: 'auto', margin: 0 }}>
              검색
            </button>
          </form>
        </div>
      </div>

      {summary && (
        <div className="card">
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>전체 제출 건수</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.total}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>간단형</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.simpleCount}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>상세형</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.detailedCount}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>⚠️ 미등록 공백 사유 건</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: summary.unloggedGapCount > 0 ? '#e8590c' : undefined }}>{summary.unloggedGapCount}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>📍 위치이탈 자동감지 건</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: summary.departureDetectedCount > 0 ? '#1971c2' : undefined }}>{summary.departureDetectedCount}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 260 }}>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>인원별 제출 현황</h3>
              {summary.byUser.length === 0 && <div style={{ fontSize: 12.5, color: '#868e96' }}>데이터 없음</div>}
              {summary.byUser.map((u) => (
                <div key={u.name} style={{ fontSize: 12.5, display: 'flex', justifyContent: 'space-between', gap: 12, maxWidth: 320 }}>
                  <span>{u.name}</span>
                  <span style={{ color: '#868e96' }}>
                    {u.count}건 (상세 {u.detailedCount} · 평균 {hoursLabel(u.avgMinutes)})
                  </span>
                </div>
              ))}
            </div>
            <div style={{ minWidth: 200 }}>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>고객사별 방문 건수</h3>
              {summary.byClient.length === 0 && <div style={{ fontSize: 12.5, color: '#868e96' }}>데이터 없음</div>}
              {summary.byClient.map((c) => (
                <div key={c.name} style={{ fontSize: 12.5, display: 'flex', justifyContent: 'space-between', maxWidth: 260 }}>
                  <span>{c.name}</span>
                  <span style={{ fontWeight: 600 }}>{c.count}건</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>제출 내역 {rows && `(${rows.length}건)`}</h2>
        {!rows && <div className="board-empty">불러오는 중...</div>}
        {rows && rows.length === 0 && <div className="board-empty">해당 기간/조건의 제출 내역이 없습니다.</div>}
        {rows && rows.length > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>이름</th>
                  <th>부서</th>
                  <th>유형</th>
                  <th>방문 고객사/근무형태</th>
                  <th>이슈/특이사항</th>
                  <th>내일 예정 업무</th>
                  <th>근무시간</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.workDate)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.userName}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.departmentName ?? '-'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.formType === 'DETAILED' ? '상세형' : '간단형'}</td>
                      <td style={{ maxWidth: 180, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                        {r.visitedClients || r.workTypeSnapshot || '-'}
                      </td>
                      <td style={{ maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.issues}</td>
                      <td style={{ maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.tomorrowPlan}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {hoursLabel(r.totalWorkedMinutes)}
                        {r.unloggedGapMinutes != null && (
                          <span title={`미등록 공백 ${Math.floor(r.unloggedGapMinutes / 60)}시간 ${r.unloggedGapMinutes % 60}분`} style={{ marginLeft: 4, color: '#e8590c' }}>
                            ⚠️
                          </span>
                        )}
                        {r.departureEvents.length > 0 && (
                          <span
                            title={`위치이탈 자동감지 ${r.departureEvents.length}건`}
                            style={{ marginLeft: 4, color: '#1971c2' }}
                          >
                            📍
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          style={{ width: 'auto', margin: 0, padding: '4px 10px', fontSize: 12 }}
                          onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        >
                          {expandedId === r.id ? '접기' : '자세히'}
                        </button>
                      </td>
                    </tr>
                    {expandedId === r.id && (
                      <tr>
                        <td colSpan={9} style={{ background: '#f8f9fa', fontSize: 12.5, lineHeight: 1.7 }}>
                          {r.unloggedGapMinutes != null && (
                            <div style={{ marginBottom: 6, color: '#e8590c' }}>
                              <strong>⚠️ 미등록 공백 {Math.floor(r.unloggedGapMinutes / 60)}시간 {r.unloggedGapMinutes % 60}분 사유</strong>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{r.unloggedGapReason || '(사유 없음)'}</div>
                            </div>
                          )}
                          {r.departureEvents.length > 0 && (
                            <div style={{ marginBottom: 6, color: '#1971c2' }}>
                              <strong>📍 위치이탈 자동감지 ({r.departureEvents.length}건)</strong>
                              {r.departureEvents.map((e, i) => (
                                <div key={i}>
                                  {formatTime(e.at)} 이탈 —{' '}
                                  {e.locationDistanceMeters == null
                                    ? '거리 확인 불가(위치 미확인)'
                                    : e.locationMatch
                                    ? `등록된 고객사 위치와 일치 (약 ${e.locationDistanceMeters}m)`
                                    : `등록된 고객사 위치에서 약 ${e.locationDistanceMeters}m 이탈`}
                                </div>
                              ))}
                            </div>
                          )}
                          {r.workContent && (
                            <div style={{ marginBottom: 6 }}>
                              <strong>주요 작업내용</strong>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{r.workContent}</div>
                            </div>
                          )}
                          {r.followUp && (
                            <div style={{ marginBottom: 6 }}>
                              <strong>후속조치/미해결 건</strong>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{r.followUp}</div>
                            </div>
                          )}
                          {r.supportRequest && (
                            <div>
                              <strong>지원요청/공유사항</strong>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{r.supportRequest}</div>
                            </div>
                          )}
                          {!r.workContent && !r.followUp && !r.supportRequest && r.unloggedGapMinutes == null && r.departureEvents.length === 0 && (
                            <span style={{ color: '#868e96' }}>추가로 기록된 내용이 없습니다.</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
