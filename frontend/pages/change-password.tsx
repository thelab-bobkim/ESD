import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, setToken } from '@/lib/api';

interface MeResponse {
  name: string;
  roles: string[];
  mustChangePassword: boolean;
}

export default function ChangePasswordPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<MeResponse>('/auth/me').then(setMe).catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 10) {
      setError('새 비밀번호는 10자 이상이어야 합니다.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('새 비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    setLoading(true);
    try {
      // 비밀번호를 바꾸면 서버가 이전 토큰을 전부 무효화하고 새 토큰을 돌려준다 — 그걸 안 갈아끼우면
      // 다음 화면에서 바로 "다시 로그인해야 합니다"로 튕겨나가므로 반드시 저장해야 한다.
      const result = await apiFetch<{ changed: boolean; accessToken: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setToken(result.accessToken);
      const isAdmin = (me?.roles ?? []).some((r) => ['HR_ADMIN', 'SYSTEM_ADMIN', 'TEAM_LEAD', 'PILOT_MANAGER'].includes(r));
      router.push(isAdmin ? '/admin/dashboard' : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '비밀번호 변경에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  if (!me) return <div className="page">불러오는 중...</div>;

  return (
    <div className="page">
      <h1>비밀번호 변경</h1>
      <div className="card">
        {me.mustChangePassword ? (
          <div className="error" style={{ marginBottom: 12 }}>
            처음 로그인하셨네요. 계속 이용하시려면 임시 비밀번호를 새 비밀번호로 바꿔주세요.
          </div>
        ) : (
          <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>{me.name}님의 비밀번호를 변경합니다.</p>
        )}
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <input
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            type="password"
            placeholder="현재(임시) 비밀번호"
          />
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            type="password"
            placeholder="새 비밀번호 (10자 이상)"
          />
          <input
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            placeholder="새 비밀번호 확인"
          />
          <button type="submit" disabled={loading}>{loading ? '변경 중...' : '비밀번호 변경'}</button>
        </form>
      </div>
    </div>
  );
}
