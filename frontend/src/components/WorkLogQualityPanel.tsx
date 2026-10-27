import { useEffect, useRef, useState } from 'react';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

/**
 * 업무일지 점검 (2026-10-15) — 직원들이 일일업무일지를 잘 쓰고 있는지(작성률), 성의 있게 쓰는지(내용 품질),
 * 고객사 작업 기록과 맞는지, 데이터로 활용할 수 있는지를 보여준다. 점수는 참고용 점검 지표이며 개인 평가 기준이 아니다.
 */
type Grade = 'GOOD' | 'FAIR' | 'POOR';
interface Quality {
  from: string; to: string; capped: boolean;
  totals: {
    userCount: number; completedDays: number; logDays: number; coverageRate: number | null;
    good: number; fair: number; poor: number; usableRate: number | null; avgScore: number | null;
    clientMatchRate: number | null; avgContentLength: number | null;
  };
  byFlag: { flag: string; label: string; count: number; userCount: number }[];
  users: {
    userName: string; departmentName: string | null; completedDays: number; logDays: number; coverageRate: number | null; avgScore: number | null;
    good: number; fair: number; poor: number; topFlags: { flag: string; label: string; count: number }[]; missingDates: string[];
  }[];
  departments: { name: string; userCount: number; completedDays: number; logDays: number; coverageRate: number | null; avgScore: number | null }[];
  daily: { date: string; completedDays: number; logDays: number; avgScore: number | null }[];
  samples: { userName: string; dateKey: string; score: number; grade: Grade; flags: string[]; issues: string; workContent: string; tomorrowPlan: string }[];
}

const GRADE_LABEL: Record<Grade, string> = { GOOD: '양호', FAIR: '보통', POOR: '미흡' };
const GRADE_COLOR: Record<Grade, string> = { GOOD: '#2b8a3e', FAIR: '#e67700', POOR: '#c92a2a' };
const FLAG_LABEL: Record<string, string> = {
  PLAN_WEAK: '내일 예정 업무가 성의 없음', ISSUES_JUNK: '이슈/특이사항이 의미 없는 입력', CONTENT_MISSING: '작업내용 비어 있음',
  CONTENT_SHORT: '작업내용이 너무 짧음', CLIENT_NOT_IN_LOG: '작업한 고객사가 일지에 없음', VISIT_WITHOUT_EFFORT: '방문지는 있는데 작업 기록 없음',
  COPY_OF_PREVIOUS: '전날 내용과 동일(복사 의심)', CLIENT_UNREGISTERED: '방문지가 등록 고객사와 매칭 안 됨', EFFORT_SNAPSHOT_DIFF: '일지 공수와 작업 기록 합계가 크게 다름',
};
/** 문제 유형별 "무엇을 하면 좋은지" — 데이터 활용 관점의 개선 안내. */
const FLAG_ADVICE: Record<string, string> = {
  PLAN_WEAK: '"없음/미정" 대신 다음 날 할 일을 한 줄이라도 적도록 안내하세요.',
  ISSUES_JUNK: '문제가 없으면 "특이사항 없음"처럼 문장으로 쓰도록 안내하세요.',
  CONTENT_MISSING: '고객사 작업을 한 날은 무엇을 했는지 최소 한 줄은 쓰도록 안내하세요.',
  CONTENT_SHORT: '"점검함"보다 "서버 로그 정리 및 디스크 점검"처럼 대상·작업이 보이게 쓰도록 안내하세요.',
  CLIENT_NOT_IN_LOG: '고객사 작업 기록은 있는데 일지엔 없습니다. 방문 고객사 칸을 확인하도록 안내하세요.',
  VISIT_WITHOUT_EFFORT: '방문지만 적고 작업 기록(시작·종료)을 안 남긴 경우입니다. 공수 집계에서 빠집니다.',
  COPY_OF_PREVIOUS: '전날 일지를 그대로 복사한 경우입니다. 그날 한 일로 고치도록 안내하세요.',
  CLIENT_UNREGISTERED: '고객사 목록에서 선택하지 않고 직접 적으면 고객사별 집계가 어긋납니다.',
  EFFORT_SNAPSHOT_DIFF: '일지를 쓴 뒤 작업 기록이 수정된 경우일 수 있습니다. 필요하면 확인하세요.',
};

function pct(v: number | null): string { return v == null ? '-' : `${v}%`; }
function dayLabel(d: string): string { return d.slice(5).replace('-', '/'); }

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? '#2b8a3e' : tone === 'warn' ? '#e67700' : tone === 'bad' ? '#c92a2a' : '#212529';
  return (
    <div style={{ flex: '1 1 150px', border: '1px solid #e9ecef', borderRadius: 10, padding: '10px 12px', minWidth: 140 }}>
      <div style={{ fontSize: 12, color: '#868e96' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: '#868e96' }}>{sub}</div>}
    </div>
  );
}

function toneForRate(v: number | null, good: number, warn: number): 'ok' | 'warn' | 'bad' | undefined {
  if (v == null) return undefined;
  return v >= good ? 'ok' : v >= warn ? 'warn' : 'bad';
}

export default function WorkLogQualityPanel({ from, to, onAuthExpired }: { from: string; to: string; onAuthExpired: () => void }) {
  const [data, setData] = useState<Quality | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    setData(null);
    setError(null);
    apiFetch<Quality>(`/attendance/admin/field-check/work-log-quality?from=${from}&to=${to}`)
      .then((d) => { if (reqRef.current === id) setData(d); })
      .catch((e) => {
        if (reqRef.current !== id) return;
        if (isAuthExpiredError(e)) { onAuthExpired(); return; }
        setError(e instanceof Error ? e.message : '오류가 발생했습니다.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="card"><p style={{ margin: 0, color: '#868e96' }}>불러오는 중…</p></div>;

  const t = data.totals;
  const maxFlag = Math.max(1, ...data.byFlag.map((f) => f.count));
  const notWritten = t.completedDays - t.logDays;

  return (
    <div data-testid="work-log-quality">
      <div className="card">
        <h2>업무일지 점검 ({dayLabel(data.from)} ~ {dayLabel(data.to)})</h2>
        <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>
          작성률은 "직접 퇴근까지 마친 날" 대비 일지가 있는 날입니다(다우오피스 동기화 기록 제외). 점수는 빈 값·의미 없는 입력·전날 복사·고객사 작업 기록과의 불일치를 감점한 참고 지표이며,
          80점 이상을 "양호(데이터로 쓸 수 있음)"로 봅니다. 개인 평가가 아니라 안내가 필요한 곳을 찾기 위한 용도입니다.
        </p>
        {data.capped && <div className="notice-inline-orange" style={{ marginBottom: 8 }}>⚠️ 데이터가 많아 일부만 반영됐어요. 기간을 줄여서 보세요.</div>}
        {t.completedDays === 0 && t.good + t.fair + t.poor === 0 ? (
          <p style={{ margin: 0 }}>이 기간에는 점검할 업무일지가 없어요.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Tile label="작성률" value={pct(t.coverageRate)} sub={`퇴근한 ${t.completedDays}일 중 ${t.logDays}일 작성${notWritten > 0 ? ` · 미작성 ${notWritten}일` : ''}`} tone={toneForRate(t.coverageRate, 95, 80)} />
              <Tile label="활용 가능한 일지" value={pct(t.usableRate)} sub={`양호 ${t.good} · 보통 ${t.fair} · 미흡 ${t.poor}`} tone={toneForRate(t.usableRate, 70, 40)} />
              <Tile label="평균 점수" value={t.avgScore == null ? '-' : `${t.avgScore}점`} sub="100점 만점" tone={toneForRate(t.avgScore, 80, 60)} />
              <Tile label="고객사 매칭률" value={pct(t.clientMatchRate)} sub="방문 고객사가 등록 고객사와 일치" tone={toneForRate(t.clientMatchRate, 90, 70)} />
            </div>
            <p style={{ fontSize: 12.5, marginBottom: 0 }}>
              작업내용 평균 길이 {t.avgContentLength == null ? '-' : `${Math.round(t.avgContentLength)}자`} · 점검 대상 {t.userCount}명
            </p>
          </>
        )}
      </div>

      {data.byFlag.length > 0 && (
        <div className="card">
          <h2>자주 나오는 문제</h2>
          <div className="table-scroll">
            <table style={{ minWidth: 640 }}>
              <thead><tr><th>문제</th><th style={{ width: 220 }}>건수</th><th>인원</th><th>안내 방법</th></tr></thead>
              <tbody>
                {data.byFlag.map((f) => (
                  <tr key={f.flag}>
                    <td>{FLAG_LABEL[f.flag] ?? f.label}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ height: 10, borderRadius: 5, background: '#fa5252', width: `${Math.max(4, (f.count / maxFlag) * 150)}px` }} />
                        <span>{f.count}건</span>
                      </div>
                    </td>
                    <td>{f.userCount}명</td>
                    <td style={{ fontSize: 12.5, color: '#495057' }}>{FLAG_ADVICE[f.flag] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h2>직원별 ({data.users.length}명)</h2>
        <p style={{ fontSize: 12.5, color: '#868e96', marginTop: 0 }}>미작성일이 많은 직원, 그다음 평균 점수가 낮은 직원이 위에 나옵니다.</p>
        <div className="table-scroll">
          <table style={{ minWidth: 900 }}>
            <thead>
              <tr><th>이름</th><th>부서</th><th>작성</th><th>작성률</th><th>평균 점수</th><th>양호/보통/미흡</th><th>주요 문제</th><th>최근 미작성일</th></tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={`${u.userName}-${u.departmentName}`}>
                  <td>{u.userName}</td>
                  <td>{u.departmentName ?? '-'}</td>
                  <td>{u.logDays}/{u.completedDays}일</td>
                  <td style={{ color: u.coverageRate != null && u.coverageRate < 80 ? '#c92a2a' : undefined, fontWeight: u.coverageRate != null && u.coverageRate < 80 ? 700 : undefined }}>{pct(u.coverageRate)}</td>
                  <td>{u.avgScore == null ? '-' : `${u.avgScore}점`}</td>
                  <td>{u.good}/{u.fair}/{u.poor}</td>
                  <td style={{ fontSize: 12.5 }}>{u.topFlags.length === 0 ? '-' : u.topFlags.map((f) => `${FLAG_LABEL[f.flag] ?? f.label} ${f.count}`).join(', ')}</td>
                  <td style={{ fontSize: 12.5 }}>{u.missingDates.length === 0 ? '-' : u.missingDates.map(dayLabel).join(', ')}</td>
                </tr>
              ))}
              {data.users.length === 0 && <tr><td colSpan={8} style={{ color: '#868e96' }}>데이터가 없어요.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {data.departments.length > 0 && (
        <div className="card">
          <h2>부서별</h2>
          <div className="table-scroll">
            <table style={{ minWidth: 520 }}>
              <thead><tr><th>부서</th><th>인원</th><th>작성</th><th>작성률</th><th>평균 점수</th></tr></thead>
              <tbody>
                {data.departments.map((d) => (
                  <tr key={d.name}>
                    <td>{d.name}</td><td>{d.userCount}명</td><td>{d.logDays}/{d.completedDays}일</td><td>{pct(d.coverageRate)}</td><td>{d.avgScore == null ? '-' : `${d.avgScore}점`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.daily.length > 0 && (
        <div className="card">
          <h2>일자별 추이</h2>
          <div className="table-scroll">
            <table style={{ minWidth: 520 }}>
              <thead><tr><th>날짜</th><th>작성</th><th style={{ width: 220 }}>작성률</th><th>평균 점수</th></tr></thead>
              <tbody>
                {data.daily.map((d) => {
                  const r = d.completedDays > 0 ? Math.round((d.logDays / d.completedDays) * 100) : null;
                  return (
                    <tr key={d.date}>
                      <td>{dayLabel(d.date)}</td>
                      <td>{d.logDays}/{d.completedDays}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ height: 10, borderRadius: 5, background: r != null && r < 80 ? '#fa5252' : '#51cf66', width: `${r == null ? 0 : Math.max(3, r * 1.5)}px` }} />
                          <span>{pct(r)}</span>
                        </div>
                      </td>
                      <td>{d.avgScore == null ? '-' : `${d.avgScore}점`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.samples.length > 0 && (
        <div className="card">
          <h2>개선이 필요한 일지 (점수 낮은 순 {data.samples.length}건)</h2>
          <div className="table-scroll">
            <table style={{ minWidth: 860 }}>
              <thead><tr><th>날짜</th><th>이름</th><th>점수</th><th>문제</th><th>이슈/특이사항</th><th>작업내용</th><th>내일 예정</th></tr></thead>
              <tbody>
                {data.samples.map((s) => (
                  <tr key={`${s.userName}-${s.dateKey}`}>
                    <td>{dayLabel(s.dateKey)}</td>
                    <td>{s.userName}</td>
                    <td style={{ color: GRADE_COLOR[s.grade], fontWeight: 700 }}>{s.score}점 ({GRADE_LABEL[s.grade]})</td>
                    <td style={{ fontSize: 12.5 }}>{s.flags.map((f) => FLAG_LABEL[f] ?? f).join(', ')}</td>
                    <td style={{ fontSize: 12.5 }}>{s.issues || '-'}</td>
                    <td style={{ fontSize: 12.5 }}>{s.workContent || '-'}</td>
                    <td style={{ fontSize: 12.5 }}>{s.tomorrowPlan || '-'}</td>
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
