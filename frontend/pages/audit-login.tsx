import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, setToken } from '@/lib/api';

type Step = 'CREDENTIALS' | 'ENROLL' | 'VERIFY';

interface StartResponse {
  step: 'ENROLL' | 'VERIFY';
  enrollToken?: string;
  qrDataUrl?: string;
  secret?: string;
  verifyToken?: string;
}
interface FinishResponse {
  accessToken: string;
  user: { id: string; name: string; roles: string[] };
}

/**
 * "감사인 전용 로그인" 화면(2026-09-20, 대표이사 요청).
 *
 * 일반 직원/관리자 로그인(/login)과 완전히 분리된 별도 페이지다 — 다른 어느 화면에서도 이
 * 페이지로 가는 링크를 두지 않는다(감사인 본인만 이 주소를 알고 있으면 됨). 아이디+비번을
 * 먼저 확인한 뒤, OTP 인증앱(구글 OTP 등) 2단계 인증을 반드시 통과해야 로그인이 완료된다.
 * 최초 로그인이면 QR코드를 보여주고 인증앱 등록부터 진행한다.
 */
export default function AuditLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('CREDENTIALS');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleCredentialsSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await apiFetch<StartResponse>('/auth/audit-login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });
      if (data.step === 'ENROLL') {
        setPendingToken(data.enrollToken || '');
        setQrDataUrl(data.qrDataUrl || '');
        setSecret(data.secret || '');
        setStep('ENROLL');
      } else {
        setPendingToken(data.verifyToken || '');
        setStep('VERIFY');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = step === 'ENROLL' ? '/auth/audit-login/enroll-confirm' : '/auth/audit-login/verify';
      const body = step === 'ENROLL' ? { enrollToken: pendingToken, code } : { verifyToken: pendingToken, code };
      const data = await apiFetch<FinishResponse>(path, { method: 'POST', body: JSON.stringify(body) });
      setToken(data.accessToken);
      router.push('/audit');
    } catch (err) {
      setError(err instanceof Error ? err.message : '인증에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <Head>
        <title>감사인 로그인</title>
      </Head>
      <h1>DSTI-TSB 감사</h1>
      <div className="card">
        {step === 'CREDENTIALS' && (
          <>
            <h2>감사인 로그인</h2>
            {error && <div className="error">{error}</div>}
            <form onSubmit={handleCredentialsSubmit}>
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
              <button type="submit" disabled={loading}>{loading ? '확인 중...' : '다음'}</button>
            </form>
          </>
        )}

        {step === 'ENROLL' && (
          <>
            <h2>OTP 인증앱 등록</h2>
            <p style={{ fontSize: 13, color: '#666' }}>
              처음 로그인하셨습니다. 구글 OTP(Google Authenticator) 등 인증앱으로 아래 QR코드를 스캔한 뒤,
              앱에 표시되는 6자리 코드를 입력해주세요.
            </p>
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt="OTP 등록 QR코드" style={{ display: 'block', margin: '12px auto', width: 200, height: 200 }} />
            )}
            {secret && (
              <p style={{ fontSize: 12, color: '#999', textAlign: 'center', wordBreak: 'break-all' }}>
                QR을 스캔할 수 없다면 이 코드를 직접 입력하세요: <strong>{secret}</strong>
              </p>
            )}
            {error && <div className="error">{error}</div>}
            <form onSubmit={handleCodeSubmit}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="인증앱 6자리 코드"
                inputMode="numeric"
                autoFocus
              />
              <button type="submit" disabled={loading || code.length !== 6}>{loading ? '확인 중...' : '등록 완료'}</button>
            </form>
          </>
        )}

        {step === 'VERIFY' && (
          <>
            <h2>인증앱 코드 입력</h2>
            <p style={{ fontSize: 13, color: '#666' }}>인증앱에 표시된 6자리 코드를 입력해주세요.</p>
            {error && <div className="error">{error}</div>}
            <form onSubmit={handleCodeSubmit}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="인증앱 6자리 코드"
                inputMode="numeric"
                autoFocus
              />
              <button type="submit" disabled={loading || code.length !== 6}>{loading ? '확인 중...' : '로그인'}</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
