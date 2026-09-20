import { useEffect } from 'react';
import { useRouter } from 'next/router';

/**
 * 2026-09-20: "감사인 계정은 따로 빼서"(대표이사 요청)에 따라 이 화면은 더 이상 쓰지 않는다 —
 * 재택 위치 감사는 이제 일반 관리자 로그인/화면과 완전히 분리된 /audit-login → /audit 로만
 * 접근한다(해당 화면들은 AdminHeader 메뉴에도 노출하지 않는다). 이 경로를 기억하고 있던 사람이
 * 실수로 들어와도 새 화면으로 보내기만 하고 끝낸다 — 어차피 이 계정 토큰으로는
 * /audit-location/remote API 자체가 AUDITOR 권한 없이는 403이라 안전하다.
 */
export default function AdminAuditLocationRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/audit');
  }, [router]);
  return null;
}
