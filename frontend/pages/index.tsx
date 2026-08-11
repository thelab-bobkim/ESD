import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
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

interface MeResponse {
  name: string; email: string; roles: string[]; workType: string; department: string; assignedClient: string | null;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function EmployeeHome() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nightWorkSessionId, setNightWorkSessionId] = useState<string | null>(null);

  // 고객사 미팅/작업 상세입력 폼 상태
  const [showClientForm, setShowClientForm] = useState(false);
  const [clientName, setClientName] = useState('');
  const [meetingStart, setMeetingStart] = useState(nowHHMM());
  const [meetingEnd, setMeetingEnd] = useState('');
  const [workDetail, setWorkDetail] = useState('');

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
    if (code === 'CLIENT_MEETING') {
      setShowClientForm(true);
      setClientName('');
      setMeetingStart(nowHHMM());
      setMeetingEnd('');
      setWorkDetail('');
      return;
    }
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code }) }),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다.`
    );
  }

  function submitClientForm() {
    const note = `고객사: ${clientName} | 시작 ${meetingStart}${meetingEnd ? ` | 완료 ${meetingEnd}` : ' | 진행중'} | 내용: ${workDetail}`;
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: 'CLIENT_MEETING', note }) }),
      "상태가 '고객사 미팅/작업'(으)로 변경되었습니다."
    );
    setShowClientForm(false);
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  if (!me) return <div className="page">불러오는 중...</div>;

  return (
    <div className="employee-shell">
      <Head>
        <title>기술부 현황 등록</title>
      </Head>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: 0 }}>안녕하세요, {me.name}님</h1>
          <p style={{ color: '#666', marginTop: 4 }}>{me.department} · {me.workType}{me.assignedClient ? ` · ${me.assignedClient}` : ''}</p>
        </div>
        <button className="secondary" style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }} onClick={logout}>로그아웃</button>
      </div>

      {message && <div className="card col-full" style={{ background: '#eef7ee' }}>{message}</div>}

      <div className="employee-grid">
        {/* 왼쪽 열 */}
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

              {/* 휴게/야간근무도 같은 아이콘 스타일로 통합 */}
              <div className="status-icon-btn" onClick={() => run(() => apiFetch('/attendance/break/start', { method: 'POST' }), '휴게를 시작합니다.')}>
                <div className="status-icon-emoji">⏸️</div>
                <div className="status-icon-label">휴게 시작</div>
              </div>
              <div className="status-icon-btn" onClick={() => run(() => apiFetch('/attendance/break/end', { method: 'POST' }), '휴게를 종료합니다.')}>
                <div className="status-icon-emoji">▶️</div>
                <div className="status-icon-label">휴게 종료</div>
              </div>
              <div
                className="status-icon-btn"
                onClick={() =>
                  run(async () => {
                    const session = await apiFetch<{ id: string }>('/night-work/start', { method: 'POST', body: JSON.stringify({}) });
                    setNightWorkSessionId(session.id);
                  }, '야간근무를 시작합니다.')
                }
              >
                <div className="status-icon-emoji">🌜</div>
                <div className="status-icon-label">야간근무 시작</div>
              </div>
              <div
                className="status-icon-btn"
                style={{ opacity: nightWorkSessionId ? 1 : 0.4, cursor: nightWorkSessionId ? 'pointer' : 'not-allowed' }}
                onClick={() => {
                  if (!nightWorkSessionId) return;
                  run(async () => {
                    await apiFetch('/night-work/end', { method: 'POST', body: JSON.stringify({ sessionId: nightWorkSessionId }) });
                    setNightWorkSessionId(null);
                  }, '야간근무를 종료했습니다. 대체휴무 전환 후보가 생성되었을 수 있습니다 — 대체휴무 신청 화면에서 확인하세요.');
                }}
              >
                <div className="status-icon-emoji">🌅</div>
                <div className="status-icon-label">야간근무 종료</div>
              </div>
            </div>
          </div>

          {me.assignedClient && (
            <div className="card">
              <h2>고객사 상주 도착체크</h2>
              <button onClick={() => run(() => apiFetch('/resident/checkin', { method: 'POST' }), '도착체크가 완료되었습니다.')}>도착체크</button>
              <button className="secondary" onClick={() => run(() => apiFetch('/resident/confirm', { method: 'POST' }), '현재 상태를 재확인했습니다.')}>상태 재확인</button>
            </div>
          )}
        </div>

        {/* 오른쪽 열: 고객사 미팅/작업 상세입력 폼 */}
        <div>
          {showClientForm && (
            <div className="card">
              <h2>🤝 고객사 미팅/작업 내역</h2>
              <label className="field-label">고객사명</label>
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="예: OO상사" />
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label">시작시간</label>
                  <input type="time" value={meetingStart} onChange={(e) => setMeetingStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">완료시간(선택)</label>
                  <input type="time" value={meetingEnd} onChange={(e) => setMeetingEnd(e.target.value)} />
                </div>
              </div>
              <label className="field-label">작업 내역</label>
              <textarea
                rows={3}
                placeholder="예: 서버 점검 및 백업 정책 협의"
                value={workDetail}
                onChange={(e) => setWorkDetail(e.target.value)}
              />
              <button disabled={!clientName.trim() || !workDetail.trim()} onClick={submitClientForm}>등록</button>
              <button className="secondary" onClick={() => setShowClientForm(false)}>취소</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
