import { useRouter } from 'next/router';
import { clearToken } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/admin/dashboard', label: '상황판', icon: '📊' },
  { href: '/admin/clients', label: '고객사 위치관리', icon: '📍' },
  { href: '/admin/calendar', label: '캘린더', icon: '🗓️' },
  { href: '/admin/reports', label: '출퇴근·근로시간·공수', icon: '📋' },
  { href: '/admin/approvals', label: '승인함', icon: '✅' },
];

interface Props {
  title: string;
  eyebrow?: string;
}

/**
 * 관리자 화면 공통 상단바 — 5개 관리자 페이지(상황판/고객사/캘린더/리포트/승인함)가 이 컴포넌트를
 * 공유한다. 예전엔 각 페이지가 h1 + 버튼 여러 개를 flex-wrap 없이 한 줄에 욱여넣어서, 화면이
 * 좁은 모바일에서는 글자가 세로로 한 글자씩 찌그러지는 문제가 있었다(줄바꿈이 아예 안 됐음).
 * 지금은 폭이 좁아지면 자연스럽게 다음 줄로 넘어간다.
 */
export default function AdminHeader({ title, eyebrow = 'DSTI-TSB 관리자' }: Props) {
  const router = useRouter();

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="admin-header">
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
