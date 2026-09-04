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
      // 관리자 권한이 있어도 우선 클라이언트(직원) 화면으로 보낸다. 관리자 화면은 그 안의
      // 버튼을 눌러서 별도로 들어가게 한다 — 관리자도 본인 상태를 등록/테스트할 일이 많아서.
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <Head>
        <title>DSTI-TSB</title>
      </Head>
      <h1>DSTI-TSB</h1>
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
        <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
          처음 오셨나요? <a href="/register">계정 등록하기</a>
        </p>
        <p style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
          비밀번호를 잊으셨나요? <a href="/reset-password">비밀번호 재설정</a>
        </p>
      </div>
    </div>
  );
}

