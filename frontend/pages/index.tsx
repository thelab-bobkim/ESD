import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';

// 관리자 상황판(admin/dashboard.tsx)과 동일한 아이콘/라벨을 써서 화면 간 일관성을 유지한다.
const STATUS_META: Record<string, { label: string; icon: string }> = {
  HQ_WORKING: { label: '본사근무', icon: '🏢' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬' },
  OFFSITE: { label: '외근', icon: '🚗' },
  CLIENT_MEETING: { label: '고객사 미팅/작업', icon: '🤝' },
  MOVING: { label: '이동중', icon: '🚙' },
  MEETING: { label: '회의중', icon: '👥' },
  REMOTE: { label: '재택(집)', icon: '🏠' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🌴' },
  ON_LEAVE: { label: '휴가', icon: '🌴' },
};

// 이 상태를 선택하면 내용(메모)을 반드시 입력받는다.
const NOTE_REQUIRED_STATUSES = new Set(['CLIENT_MEETING']);

interface MeResponse {
  name: string; email: string; roles: string[]; workType: string; department: string; assignedClient: string | null;
}

export default function EmployeeHome() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nightWorkSessionId, setNightWorkSessionId] = useState<string | null>(null);
  const [noteInputStatus, setNoteInputStatus] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

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

  function changeStatus(code: string) {
    if (NOTE_REQUIRED_STATUSES.has(code)) {
      setNoteInputStatus(code);
      setNoteText('');
      return;
    }
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code }) }),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다.`
    );
  }

  function submitNoteStatus() {
    if (!noteInputStatus) return;
    const code = noteInputStatus;
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code, note: noteText }) }),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다.`
    );
    setNoteInputStatus(null);
    setNoteText('');
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  if (!me) return <div className="page">불러오는 중...</div>;

  return (
    <div className="employee-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: 0 }}>안녕하세요, {me.name}님</h1>
          <p style={{ color: '#666', marginTop: 4 }}>{me.department} · {me.workType}{me.assignedClient ? ` · ${me.assignedClient}` : ''}</p>
        </div>
        <button className="secondary" style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }} onClick={logout}>로그아웃</button>
      </div>

      {message && <div className="card col-full" style={{ background: '#eef7ee' }}>{message}</div>}

      <div className="employee-grid">
        {/* 왼쪽 열: 자주 쓰는 핵심 동작 */}
        <div>
          <div className="card">
            <h2>출퇴근</h2>
            <button onClick={() => run(() => apiFetch('/attendance/clock-in', { method: 'POST' }), '출근 처리되었습니다.')}>출근</button>
            <button className="secondary" onClick={() => run(() => apiFetch('/attendance/clock-out', { method: 'POST' }), '퇴근 처리되었습니다.')}>퇴근</button>
          </div>

          <div className="card">
            <h2>지금 뭐 하고 계세요?</h2>
            <div className="status-icon-grid">
              {Object.entries(STATUS_META).map(([code, meta]) => (
                <div key={code} className="status-icon-btn" onClick={() => changeStatus(code)}>
                  <div className="status-icon-emoji">{meta.icon}</div>
                  <div className="status-icon-label">{meta.label}</div>
                </div>
              ))}
            </div>

            {noteInputStatus && (
              <div className="note-input-box">
                <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
                  {STATUS_META[noteInputStatus].icon} {STATUS_META[noteInputStatus].label} — 어디서 무슨 일인지 간단히 적어주세요
                </div>
                <textarea
                  autoFocus
                  rows={3}
                  placeholder="예: OO고객사 방문, 서버 점검 작업"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ margin: 0 }} disabled={!noteText.trim()} onClick={submitNoteStatus}>확인</button>
                  <button style={{ margin: 0 }} className="secondary" onClick={() => setNoteInputStatus(null)}>취소</button>
                </div>
              </div>
            )}
          </div>

          {me.assignedClient && (
            <div className="card">
              <h2>고객사 상주 도착체크</h2>
              <button onClick={() => run(() => apiFetch('/resident/checkin', { method: 'POST' }), '도착체크가 완료되었습니다.')}>도착체크</button>
              <button className="secondary" onClick={() => run(() => apiFetch('/resident/confirm', { method: 'POST' }), '현재 상태를 재확인했습니다.')}>상태 재확인</button>
            </div>
          )}
        </div>

        {/* 오른쪽 열(PC): 부가 동작 */}
        <div>
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
        </div>
      </div>
    </div>
  );
}
