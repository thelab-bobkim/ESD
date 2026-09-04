import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/admin/dashboard', label: '전직원 상황판', icon: '📊' },
  { href: '/admin/reports', label: '출/퇴근·근로시간', icon: '📋' },
  { href: '/admin/effort', label: '고객사별 공수관리', icon: '🛠️' },
  { href: '/admin/calendar', label: '캘린더', icon: '🗓️' },
  { href: '/admin/approvals', label: '승인함', icon: '✅' },
  { href: '/admin/clients', label: '고객사 위치관리', icon: '📍' },
  { href: '/admin/board-scope', label: '표시 대상 관리', icon: '🎯' },
  // 2026-09-04: 휴가현황 연동 가능 여부를 확인하기 위한 1회성 진단 화면 — 확인이 끝나면
  // 이 메뉴 항목과 페이지를 지워도 된다(admin/dauoffice-probe.tsx 상단 설명 참고).
  { href: '/admin/dauoffice-probe', label: '다우오피스 코드 진단', icon: '🔍' },
];

interface Props {
  title: string;
  eyebrow?: string;
  /** TSB-Ver2.1: 이 헤더가 다크 관제형 테마 화면(현재는 전사 상황판)에 쓰이는 경우 true.
   * 다른 5개 관리자 화면은 이 prop을 넘기지 않으므로 기존 라이트 헤더 그대로 유지된다 —
   * CSS도 .tsb-dark .admin-header 로 스코프돼 있어 여기서 클래스만 붙여주면 된다. */
  dark?: boolean;
}

/**
 * 관리자 화면 공통 상단바 — 6개 관리자 페이지(상황판/출퇴근·근로시간/공수관리/캘린더/승인함/고객사)가 이 컴포넌트를
 * 공유한다. 예전엔 각 페이지가 h1 + 버튼 여러 개를 flex-wrap 없이 한 줄에 욱여넣어서, 화면이
 * 좁은 모바일에서는 글자가 세로로 한 글자씩 찌그러지는 문제가 있었다(줄바꿈이 아예 안 됐음).
 * 지금은 폭이 좁아지면 자연스럽게 다음 줄로 넘어간다.
 */
export default function AdminHeader({ title, eyebrow = 'DSTI-TSB 관리자', dark = false }: Props) {
  const router = useRouter();
  // 2026-09-01: 승인함에 몇 건이 대기중인지 메뉴에서 바로 보여준다 — 매번 눌러서 들어가보지
  // 않아도 처리할 게 있는지 한눈에 알 수 있게. 승인 권한이 없는 계정(일반 직원)이면 API가
  // 403을 주는데, 그때는 그냥 배지를 안 보여주고 조용히 넘어간다.
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    function loadPendingCount() {
      apiFetch<unknown[]>('/approval/requests?status=PENDING')
        .then((rows) => setPendingApprovals(Array.isArray(rows) ? rows.length : 0))
        .catch(() => {});
    }
    loadPendingCount();
    const id = setInterval(loadPendingCount, 60 * 1000); // 1분마다 최신화
    return () => clearInterval(id);
  }, []);

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className={`admin-header${dark ? ' admin-header--dark' : ''}`}>
      <div className="admin-header-brand">
        <span className="admin-header-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <nav className="admin-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.href}
            type="button"
            className={`admin-nav-link${router.pathname === item.href ? ' active' : ''}`}
            onClick={() => router.push(item.href)}
          >
            <span>{item.icon}</span>{item.label}
            {item.href === '/admin/approvals' && pendingApprovals > 0 && (
              <span className="admin-nav-badge">{pendingApprovals > 99 ? '99+' : pendingApprovals}</span>
            )}
          </button>
        ))}
        <span className="admin-nav-divider" />
        <button type="button" className="admin-nav-link muted" onClick={() => router.push('/change-password')}>
          🔑 비밀번호 변경
        </button>
        <button type="button" className="admin-nav-link muted" onClick={logout}>
          🚪 로그아웃
        </button>
      </nav>
    </div>
  );
}
