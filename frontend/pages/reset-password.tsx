import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, setToken } from '@/lib/api';

interface ResetPasswordResponse {
  accessToken: string;
  user: { id: string; name: string; roles: string[] };
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [employeeNo, setEmployeeNo] = useState('');
  const [name, setName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 10) {
      setError('비밀번호는 10자 이상이어야 합니다.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<ResetPasswordResponse>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ employeeNo, name, newPassword }),
      });
      setToken(data.accessToken);
      const isAdmin = data.user.roles.some((r) => ['HR_ADMIN', 'SYSTEM_ADMIN', 'TEAM_LEAD', 'PILOT_MANAGER'].includes(r));
      router.push(isAdmin ? '/admin/dashboard' : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '재설정에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <Head>
        <title>DSTI-TSB - 비밀번호 재설정</title>
      </Head>
      <h1>DSTI-TSB</h1>
      <div className="card">
        <h2>비밀번호 재설정</h2>
        <p style={{ fontSize: 13, color: '#666', marginTop: 0 }}>
          사번과 이름을 확인한 뒤, 새로 사용할 비밀번호를 직접 설정해주세요.
        </p>
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <input value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} placeholder="사번(다우오피스 로그인ID)" autoFocus />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" />
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            type="password"
            placeholder="새 비밀번호 (10자 이상)"
            autoComplete="new-password"
          />
          <input
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            placeholder="새 비밀번호 확인"
            autoComplete="new-password"
          />
          <button type="submit" disabled={loading}>{loading ? '재설정 중...' : '비밀번호 재설정하기'}</button>
        </form>
        <p style={{ fontSize: 12, color: '#999', marginTop: 12 }}>
          <a href="/login">로그인 화면으로 돌아가기</a>
        </p>
      </div>
    </div>
  );
}
