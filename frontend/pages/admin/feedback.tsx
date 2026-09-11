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

  function load() {
    apiFetch<FeedbackRow[]>('/pilot/feedback')
      .then(setRows)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
  }

  useEffect(load, []);

  const visibleRows = rows ? rows.filter((r) => categoryFilter === 'ALL' || r.category === categoryFilter) : null;

  return (
    <div className="admin-shell">
      <AdminHeader title="피드백함" />
      <p className="admin-page-subtitle">직원들이 홈 화면에서 보낸 버그/불편사항/정책 의견을 모아서 보여줍니다.</p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2>전체 피드백 {rows && `(총 ${rows.length}건)`}</h2>
          <select style={{ margin: 0, width: 'auto' }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="ALL">전체 카테고리</option>
            <option value="BUG">🐞 버그/오류</option>
            <option value="UX">💡 불편한 점</option>
            <option value="POLICY">📋 정책 관련</option>
            <option value="OTHER">💬 기타</option>
          </select>
        </div>
        {!rows && <div className="board-empty">불러오는 중...</div>}
        {rows && rows.length === 0 && <div className="board-empty">아직 등록된 피드백이 없습니다.</div>}
        {visibleRows && rows && rows.length > 0 && visibleRows.length === 0 && (
          <div className="board-empty">해당 카테고리에 등록된 피드백이 없습니다.</div>
        )}
        {visibleRows && visibleRows.length > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>카테고리</th>
                  <th>작성자</th>
                  <th>내용</th>
                  <th>등록일시</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{CATEGORY_LABEL[r.category] ?? r.category}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.user?.name ?? '-'}</td>
                    <td style={{ maxWidth: 480 }}>{r.content}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#868e96' }}>
                      {new Date(r.createdAt).toLocaleString('ko-KR')}
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
