import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

interface FeedbackRow {
  id: string;
  category: 'BUG' | 'UX' | 'POLICY' | 'OTHER';
  content: string;
  createdAt: string;
  user: { name: string; employeeNo: string };
  resolvedAt: string | null;
  resolvedBy: { name: string } | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  BUG: '🐞 버그/오류',
  UX: '💡 불편한 점',
  POLICY: '📋 정책 관련',
  OTHER: '💬 기타',
};

/**
 * TSB-Ver3.1: 파일럿 피드백 목록 — 백엔드 API(POST /pilot/feedback)는 있었지만 이걸 등록하는
 * 화면도, 확인하는 화면도 없었다(2026-09-11 개선 제안서 참고). 이 화면은 확인용.
 */
export default function AdminFeedbackPage() {
  const router = useRouter();
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  // 2026-09-14: 조치 완료된 피드백이 쌓이면 새 피드백을 찾기 번거로워서, 기본은 "미처리만" 보여주고
  // 필요할 때만 전체(처리완료 포함)로 바꿔볼 수 있게 한다.
  const [statusFilter, setStatusFilter] = useState<'UNRESOLVED' | 'ALL'>('UNRESOLVED');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  function load() {
    apiFetch<FeedbackRow[]>('/pilot/feedback')
      .then(setRows)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
  }

  useEffect(load, []);

  async function toggleResolved(row: FeedbackRow) {
    setResolvingId(row.id);
    try {
      const updated = await apiFetch<FeedbackRow>(`/pilot/feedback/${row.id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify({ resolved: !row.resolvedAt }),
      });
      setRows((prev) => (prev ? prev.map((r) => (r.id === row.id ? updated : r)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : '처리 상태 변경에 실패했습니다.');
    } finally {
      setResolvingId(null);
    }
  }

  const categoryFiltered = rows ? rows.filter((r) => categoryFilter === 'ALL' || r.category === categoryFilter) : null;
  const visibleRows = categoryFiltered
    ? categoryFiltered.filter((r) => statusFilter === 'ALL' || !r.resolvedAt)
    : null;
  const unresolvedCount = rows ? rows.filter((r) => !r.resolvedAt).length : 0;

  return (
    <div className="admin-shell">
      <AdminHeader title="피드백함" />
      <p className="admin-page-subtitle">직원들이 홈 화면에서 보낸 버그/불편사항/정책 의견을 모아서 보여줍니다.</p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2>전체 피드백 {rows && `(총 ${rows.length}건 · 미처리 ${unresolvedCount}건)`}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select style={{ margin: 0, width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'UNRESOLVED' | 'ALL')}>
              <option value="UNRESOLVED">미처리만</option>
              <option value="ALL">전체(처리완료 포함)</option>
            </select>
            <select style={{ margin: 0, width: 'auto' }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="ALL">전체 카테고리</option>
              <option value="BUG">🐞 버그/오류</option>
              <option value="UX">💡 불편한 점</option>
              <option value="POLICY">📋 정책 관련</option>
              <option value="OTHER">💬 기타</option>
            </select>
          </div>
        </div>
        {!rows && <div className="board-empty">불러오는 중...</div>}
        {rows && rows.length === 0 && <div className="board-empty">아직 등록된 피드백이 없습니다.</div>}
        {visibleRows && rows && rows.length > 0 && visibleRows.length === 0 && (
          <div className="board-empty">
            {statusFilter === 'UNRESOLVED' ? '미처리 피드백이 없습니다. 모두 조치 완료됐어요! 🎉' : '해당 카테고리에 등록된 피드백이 없습니다.'}
          </div>
        )}
        {visibleRows && visibleRows.length > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>카테고리</th>
                  <th>작성자</th>
                  <th>내용</th>
                  <th>등록일시</th>
                  <th>처리</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.id} style={r.resolvedAt ? { opacity: 0.6 } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.resolvedAt ? (
                        <span style={{ color: '#2f9e44', fontWeight: 600 }} title={`${r.resolvedBy?.name ?? '-'}님이 처리 · ${new Date(r.resolvedAt).toLocaleString('ko-KR')}`}>
                          ✅ 조치완료
                        </span>
                      ) : (
                        <span style={{ color: '#868e96' }}>⏳ 미처리</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{CATEGORY_LABEL[r.category] ?? r.category}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.user?.name ?? '-'}</td>
                    {/* 2026-09-14: 내용이 길면 테이블 전체가 옆으로 계속 늘어나던 문제 — .table-scroll
                        th/td에 걸린 전역 white-space: nowrap을 이 칸만 인라인 스타일로 덮어써서
                        정해진 폭 안에서 줄바꿈되게 한다(인라인 스타일이 클래스보다 항상 우선). */}
                    <td style={{ maxWidth: 480, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.content}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#868e96' }}>
                      {new Date(r.createdAt).toLocaleString('ko-KR')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className={r.resolvedAt ? 'secondary' : undefined}
                        style={{ width: 'auto', margin: 0, fontSize: 12, padding: '5px 10px' }}
                        disabled={resolvingId === r.id}
                        onClick={() => toggleResolved(r)}
                      >
                        {resolvingId === r.id ? '처리 중...' : r.resolvedAt ? '미처리로 되돌리기' : '조치완료로 표시'}
                      </button>
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
