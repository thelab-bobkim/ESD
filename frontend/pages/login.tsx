import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, setToken } from '@/lib/api';

interface LoginResponse {
  accessToken: string;
  user: { id: string; name: string; roles: string[]; mustChangePassword: boolean };
}

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });
      setToken(data.accessToken);
      if (data.user.mustChangePassword) {
        router.push('/change-password');
        return;
      }
      const isAdmin = data.user.roles.some((r) => ['HR_ADMIN', 'SYSTEM_ADMIN', 'TEAM_LEAD', 'PILOT_MANAGER'].includes(r));
      router.push(isAdmin ? '/admin/dashboard' : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <Head>
        <title>Tech Status Board</title>
      </Head>
      <h1>Tech Status Board</h1>
      <div className="card">
        <h2>로그인</h2>
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="이메일 또는 사번"
            autoFocus
            autoComplete="username"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="비밀번호"
            autoComplete="current-password"
          />
          <button type="submit" disabled={loading}>{loading ? '로그인 중...' : '로그인'}</button>
        </form>
        <p style={{ fontSize: 12, color: '#666' }}>
          이메일이 없는 계정은 <strong>사번(로그인ID)</strong>으로 로그인하세요.
        </p>
      </div>
    </div>
  );
}

