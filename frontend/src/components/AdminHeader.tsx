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
  { href: '/admin/feedback', label: '피드백함', icon: '💬' },
  { href: '/admin/messages', label: '메시지함', icon: '📨' },
  // 2026-09-20: "감사인" 권한(대표이사 요청) — 아래 두 항목은 role 필터를 통과한 계정에게만
  // 보인다(다른 항목들과 달리, 존재 자체를 다른 관리자에게 노출하지 않기 위함 — "특정 감사인만"
  // 볼 수 있어야 한다는 원칙을 메뉴 노출에도 적용).
  { href: '/admin/auditors', label: '감사인 권한 관리', icon: '🛡️', requiresRole: 'SYSTEM_ADMIN' as const },
  { href: '/admin/audit-location', label: '재택 위치 감사', icon: '🛰️', requiresRole: 'AUDITOR' as const },
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
  // 2026-09-20: "감사인" 권한(대표이사 요청) — 위 NAV_ITEMS의 requiresRole 필터링에 쓴다.
  // 실패(권한 없는 계정 등)해도 조용히 빈 배열로 넘어간다(다른 배지 로딩과 동일한 관례).
  const [myRoles, setMyRoles] = useState<string[]>([]);

  useEffect(() => {
    apiFetch<{ roles: string[] }>('/auth/me')
      .then((me) => setMyRoles(Array.isArray(me.roles) ? me.roles : []))
      .catch(() => {});
  }, []);

  const visibleNavItems = NAV_ITEMS.filter((item) => !item.requiresRole || myRoles.includes(item.requiresRole));

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

  // 2026-09-16: 메시지함 메뉴에도 승인함처럼 안 읽은 직원 답장 건수를 배지로 보여준다
  // (messages.routes.ts /admin/conversations 참고). HR_ADMIN/SYSTEM_ADMIN 전용 API라 그 외
  // 역할 계정은 403을 받는데, 그때는 승인함과 동일하게 배지 없이 조용히 넘어간다.
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);

  useEffect(() => {
    function loadUnreadMessageCount() {
      apiFetch<{ unreadCount: number }[]>('/messages/admin/conversations')
        .then((rows) => setUnreadMessageCount(Array.isArray(rows) ? rows.reduce((sum, r) => sum + r.unreadCount, 0) : 0))
        .catch(() => {});
    }
    loadUnreadMessageCount();
    const id = setInterval(loadUnreadMessageCount, 30 * 1000); // 30초마다 최신화
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
        {visibleNavItems.map((item) => (
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
            {item.href === '/admin/messages' && unreadMessageCount > 0 && (
              <span className="admin-nav-badge">{unreadMessageCount > 99 ? '99+' : unreadMessageCount}</span>
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
