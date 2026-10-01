import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, apiFetchWithMeta, isAuthExpiredError, truncationNotice } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

/**
 * 야간·주말작업 보고서(아웃룩 메일) 관리자 화면.
 * 2026-09-25: 대표이사 요청 — 엔지니어들이 아웃룩 '받은편지함 > 야간작업및 주말작업' 폴더로 보내는
 * 자기보고 메일을 매번 열어보지 않고도 여기서 한눈에 보기 위함. 데이터는 Claude(외부 자동화)가
 * Microsoft 365 연동으로 주기적으로(매주 월요일/매월 1일 예정) 채워넣는다 — 이 화면은 조회 전용이고,
 * 기존 "야간근무"(직원이 앱에서 시작/종료해 대체휴무로 전환하는 근무기록)와는 완전히 별개다.
 */

interface ReportRow {
  id: string;
  kind: 'NIGHT' | 'WEEKEND';
  workDate: string;
  reporterName: string;
  reporterEmail: string;
  clientNameRaw: string;
  location: string | null;
  workTimeRaw: string | null;
  workContent: string | null;
  workers: string | null;
  note: string | null;
  tsbLocationVerified: boolean | null;
  mailReceivedAt: string;
  mailWebLink: string | null;
}

interface SummaryData {
  total: number;
  nightCount: number;
  weekendCount: number;
  byEngineer: { name: string; count: number }[];
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

export default function AdminNightWorkMailPage() {
  const router = useRouter();
  const [from, setFrom] = useState(firstDayOfThisMonth());
  const [to, setTo] = useState(toDateInputValue(new Date()));
  const [kind, setKind] = useState<'' | 'NIGHT' | 'WEEKEND'>('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  function buildQuery(): string {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (kind) params.set('kind', kind);
    if (q.trim()) params.set('q', q.trim());
    return params.toString();
  }

  // 2026-09-30(M-3): 목록 잘림 안내 + 필터 전환 시 늦은 응답 무시.
  const [truncatedLimit, setTruncatedLimit] = useState<number | null>(null);
  const loadRequestRef = useRef(0);

  function load() {
    const qs = buildQuery();
    const requestId = ++loadRequestRef.current;
    apiFetchWithMeta<ReportRow[]>(`/night-work-mail?${qs}`)
      .then(({ data, truncated, limit }) => {
        if (loadRequestRef.current !== requestId) return;
        setRows(data);
        setTruncatedLimit(truncated ? limit : null);
      })
      .catch((err) => {
        if (loadRequestRef.current !== requestId) return;
        if (isAuthExpiredError(err)) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
    apiFetch<SummaryData>(`/night-work-mail/summary?${qs}`)
      .then((s) => { if (loadRequestRef.current === requestId) setSummary(s); })
      .catch(() => {});
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [from, to, kind]);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    load();
  }

  return (
    <div className="admin-shell">
      <AdminHeader title="야간·주말작업 보고서" />
      <p className="admin-page-subtitle">
        아웃룩 &apos;받은편지함 &gt; 야간작업및 주말작업&apos; 폴더로 온 엔지니어 자기보고 메일을 그대로 정리한 열람 전용
        화면입니다. TSB GPS 위치대조 실데이터와의 교차검증은 아직 연동 전이라 &quot;TSB 위치대조&quot; 열은 모두
        &quot;대조 예정&quot;으로 표시됩니다.
      </p>
      {error && <div className="error">{error}</div>}
      {truncatedLimit != null && <div className="notice-inline-orange">⚠️ {truncationNotice(truncatedLimit)}</div>}

      <div className="card">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            기간
            <input type="date" style={{ margin: 0, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
            ~
            <input type="date" style={{ margin: 0, width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className={kind === '' ? undefined : 'secondary'}
              style={{ width: 'auto', margin: 0 }}
              onClick={() => setKind('')}
            >
              전체
            </button>
            <button
              type="button"
              className={kind === 'NIGHT' ? undefined : 'secondary'}
              style={{ width: 'auto', margin: 0 }}
              onClick={() => setKind('NIGHT')}
            >
              🌙 야간작업
            </button>
            <button
              type="button"
              className={kind === 'WEEKEND' ? undefined : 'secondary'}
              style={{ width: 'auto', margin: 0 }}
              onClick={() => setKind('WEEKEND')}
            >
              🏖️ 주말작업
            </button>
          </div>
          <form onSubmit={onSearchSubmit} style={{ display: 'flex', gap: 4 }}>
            <input
              style={{ margin: 0, width: 260 }}
              placeholder="고객사 또는 엔지니어(보고자/작업인원) 검색"
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
              <div style={{ fontSize: 12, color: '#868e96' }}>전체 보고 건수</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.total}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>🌙 야간작업</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.nightCount}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#868e96' }}>🏖️ 주말작업</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.weekendCount}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 200 }}>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>인원별 출동 건수</h3>
              {summary.byEngineer.length === 0 && <div style={{ fontSize: 12.5, color: '#868e96' }}>데이터 없음</div>}
              {summary.byEngineer.map((e) => (
                <div key={e.name} style={{ fontSize: 12.5, display: 'flex', justifyContent: 'space-between', maxWidth: 220 }}>
                  <span>{e.name}</span>
                  <span style={{ fontWeight: 600 }}>{e.count}건</span>
                </div>
              ))}
            </div>
            <div style={{ minWidth: 240 }}>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>고객사별 방문 건수(원문 기준)</h3>
              {summary.byClient.length === 0 && <div style={{ fontSize: 12.5, color: '#868e96' }}>데이터 없음</div>}
              {summary.byClient.map((c) => (
                <div key={c.name} style={{ fontSize: 12.5, display: 'flex', justifyContent: 'space-between', maxWidth: 320 }}>
                  <span>{c.name}</span>
                  <span style={{ fontWeight: 600 }}>{c.count}건</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>보고 내역 {rows && `(${rows.length}건)`}</h2>
        {!rows && <div className="board-empty">불러오는 중...</div>}
        {rows && rows.length === 0 && <div className="board-empty">해당 기간/조건의 보고 내역이 없습니다.</div>}
        {rows && rows.length > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>구분</th>
                  <th>보고자</th>
                  <th>고객사</th>
                  <th>위치</th>
                  <th>작업시간</th>
                  <th>작업내용</th>
                  <th>작업인원</th>
                  <th>TSB 위치대조</th>
                  <th>비고</th>
                  <th>원본</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.workDate)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.kind === 'NIGHT' ? '🌙 야간작업' : '🏖️ 주말작업'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.reporterName}</td>
                    <td style={{ maxWidth: 140, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.clientNameRaw}</td>
                    <td style={{ maxWidth: 140, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.location ?? '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.workTimeRaw ?? '-'}</td>
                    <td style={{ maxWidth: 280, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.workContent ?? '-'}</td>
                    <td style={{ maxWidth: 160, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.workers ?? '-'}</td>
                    <td style={{ whiteSpace: 'nowrap', color: '#868e96' }}>
                      {r.tsbLocationVerified == null ? '대조 예정' : r.tsbLocationVerified ? '✓ 일치' : '⚠ 불일치'}
                    </td>
                    <td style={{ maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word', color: r.note ? '#e8590c' : undefined }}>{r.note ?? ''}</td>
                    <td>
                      {r.mailWebLink && (
                        <a href={r.mailWebLink} target="_blank" rel="noreferrer">
                          열기
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
