import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';

const STATUS_LABELS: Record<string, string> = {
  HQ_WORKING: '본사근무', RESIDENT_ONSITE: '고객사상주', OFFSITE: '외근', MEETING: '회의',
  MOVING: '이동', REMOTE: '재택', NIGHT_WORK: '야간작업', ALT_DAY_OFF: '대체휴무', ON_LEAVE: '휴가',
};

interface MeResponse {
  name: string; email: string; roles: string[]; workType: string; department: string; assignedClient: string | null;
}

export default function EmployeeHome() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nightWorkSessionId, setNightWorkSessionId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MeResponse>('/auth/me').then(setMe).catch(() => router.push('/login'));
  }, [router]);

  async function run(action: () => Promise<unknown>, successMsg: string) {
    setMessage(null);
    try {
      await action();
      setMessage(successMsg);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
    }
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  if (!me) return <div className="page">불러오는 중...</div>;

  return (
    <div className="page">
      <h1>안녕하세요, {me.name}님</h1>
      <p style={{ color: '#666', marginTop: -8 }}>{me.department} · {me.workType}{me.assignedClient ? ` · ${me.assignedClient}` : ''}</p>

      {message && <div className="card" style={{ background: '#eef7ee' }}>{message}</div>}

      <div className="card">
        <h2>출퇴근</h2>
        <button onClick={() => run(() => apiFetch('/attendance/clock-in', { method: 'POST' }), '출근 처리되었습니다.')}>출근</button>
        <button className="secondary" onClick={() => run(() => apiFetch('/attendance/clock-out', { method: 'POST' }), '퇴근 처리되었습니다.')}>퇴근</button>
      </div>

      <div className="card">
        <h2>현재 상태 변경</h2>
        <div className="status-grid">
          {Object.entries(STATUS_LABELS).map(([code, label]) => (
            <div
              key={code}
              className="status-badge"
              style={{ cursor: 'pointer' }}
              onClick={() => run(() => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code }) }), `상태가 '${label}'(으)로 변경되었습니다.`)}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      {me.assignedClient && (
        <div className="card">
          <h2>고객사 상주 도착체크</h2>
          <button onClick={() => run(() => apiFetch('/resident/checkin', { method: 'POST' }), '도착체크가 완료되었습니다.')}>도착체크</button>
          <button className="secondary" onClick={() => run(() => apiFetch('/resident/confirm', { method: 'POST' }), '현재 상태를 재확인했습니다.')}>상태 재확인</button>
        </div>
      )}

      <div className="card">
        <h2>휴게</h2>
        <button onClick={() => run(() => apiFetch('/attendance/break/start', { method: 'POST' }), '휴게를 시작합니다.')}>휴게 시작</button>
        <button className="secondary" onClick={() => run(() => apiFetch('/attendance/break/end', { method: 'POST' }), '휴게를 종료합니다.')}>휴게 종료</button>
      </div>

      <div className="card">
        <h2>야간근무</h2>
        <button
          onClick={() =>
            run(async () => {
              const session = await apiFetch<{ id: string }>('/night-work/start', { method: 'POST', body: JSON.stringify({}) });
              setNightWorkSessionId(session.id);
            }, '야간근무를 시작합니다.')
          }
        >
          야간근무 시작
        </button>
        <button
          className="secondary"
          disabled={!nightWorkSessionId}
          onClick={() =>
            run(async () => {
              await apiFetch('/night-work/end', { method: 'POST', body: JSON.stringify({ sessionId: nightWorkSessionId }) });
              setNightWorkSessionId(null);
            }, '야간근무를 종료했습니다. 대체휴무 전환 후보가 생성되었을 수 있습니다 — 대체휴무 신청 화면에서 확인하세요.')
          }
        >
          야간근무 종료
        </button>
      </div>

      <button className="secondary" onClick={logout}>로그아웃</button>
    </div>
  );
}
