import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, clearToken } from '@/lib/api';

// 요청하신 배열: 재택/본사근무/고객사상주, 이동중/고객사미팅/고객사작업, 야간작업/대체휴무/휴가 (총 9개)
const STATUS_META: Record<string, { label: string; icon: string }> = {
  REMOTE: { label: '재택(집)', icon: '🏠' },
  HQ_WORKING: { label: '본사근무', icon: '🏢' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬' },
  MOVING: { label: '이동중', icon: '🚙' },
  CLIENT_MEETING: { label: '고객사미팅', icon: '🤝' },
  CLIENT_WORK: { label: '고객사작업', icon: '🛠️' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️' },
  ON_LEAVE: { label: '휴가', icon: '🌴' },
};
const STATUS_ORDER = ['REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'ALT_DAY_OFF', 'ON_LEAVE'];

// 이 상태들은 클릭 시 오른쪽에 상세입력 폼을 띄운다.
const DETAIL_FORM_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK']);
// 이 상태는 프로젝트별 공수(工數) 기록 대상이라 프로젝트명 필드가 필요하다.
const EFFORT_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);

const WORK_TYPE_OPTIONS = ['정기점검', '신규설치', '장애대응', '미팅', '기타'];

interface MeResponse {
  name: string; email: string; roles: string[]; workType: string; department: string; assignedClient: string | null; mustChangePassword: boolean;
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

  // 고객사미팅/고객사작업/야간작업 공용 상세입력 폼 상태
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workStart, setWorkStart] = useState(nowHHMM());
  const [workEnd, setWorkEnd] = useState('');
  const [workType, setWorkType] = useState(WORK_TYPE_OPTIONS[0]);
  const [workDetail, setWorkDetail] = useState('');

  useEffect(() => {
    apiFetch<MeResponse>('/auth/me')
      .then((data) => {
        if (data.mustChangePassword) {
          router.push('/change-password');
          return;
        }
        setMe(data);
      })
      .catch(() => router.push('/login'));
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
    if (DETAIL_FORM_STATUSES.has(code)) {
      setDetailStatus(code);
      setClientName('');
      setProjectName('');
      setWorkStart(nowHHMM());
      setWorkEnd('');
      setWorkType(WORK_TYPE_OPTIONS[0]);
      setWorkDetail('');
      return;
    }
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code }) }),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다.`
    );
  }

  function submitDetailForm() {
    if (!detailStatus) return;
    const code = detailStatus;
    const note = `유형: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 내용: ${workDetail}`;
    const body: Record<string, unknown> = { status: code, note };
    // 고객사미팅/고객사작업은 프로젝트별 공수(工數) 기록 대상이라 구조화된 데이터도 같이 보낸다.
    if (EFFORT_STATUSES.has(code)) {
      body.effort = {
        clientName,
        projectName,
        workType,
        startTime: workStart,
        endTime: workEnd || undefined,
        description: workDetail,
      };
    }
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다.`
    );
    setDetailStatus(null);
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
          <h1 style={{ marginBottom: 0 }}>Tech Status Board</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="secondary"
            style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }}
            onClick={() => router.push('/change-password')}
          >
            비밀번호 변경
          </button>
          <button className="secondary" style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }} onClick={logout}>로그아웃</button>
        </div>
      </div>

      {message && <div className="card col-full" style={{ background: '#eef7ee' }}>{message}</div>}

      <div className="employee-grid">
        {/* 왼쪽 열 */}
        <div>
          <div className="card">
            <h2>출퇴근</h2>
            <button onClick={() => run(() => apiFetch('/attendance/clock-in', { method: 'POST' }), '출근 처리되었습니다.')}>출근</button>
            <button className="secondary" onClick={() => run(() => apiFetch('/attendance/clock-out', { method: 'POST' }), '퇴근 처리되었습니다.')}>퇴근</button>
            <p style={{ fontSize: 11, color: '#adb5bd', marginTop: 4, marginBottom: 0 }}>
              * "본사근무/고객사상주/고객사미팅/고객사작업" 상태로 바꾸거나 도착체크를 하면 출근시각이 자동으로 기록됩니다. 퇴근 버튼을 눌러야 그날 근무가 확정됩니다.
            </p>
          </div>

          <div className="card">
            <h2>지금 뭐 하고 계세요?</h2>
            <div className="status-icon-grid">
              {STATUS_ORDER.map((code) => (
                <div key={code} className="status-icon-btn" onClick={() => changeStatus(code)}>
                  <div className="status-icon-emoji">{STATUS_META[code].icon}</div>
                  <div className="status-icon-label">{STATUS_META[code].label}</div>
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
            <h2>휴게 / 야간근무 기록</h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button style={{ margin: 0 }} onClick={() => run(() => apiFetch('/attendance/break/start', { method: 'POST' }), '휴게를 시작합니다.')}>휴게 시작</button>
              <button style={{ margin: 0 }} className="secondary" onClick={() => run(() => apiFetch('/attendance/break/end', { method: 'POST' }), '휴게를 종료합니다.')}>휴게 종료</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={{ margin: 0 }}
                onClick={() =>
                  run(async () => {
                    const session = await apiFetch<{ id: string }>('/night-work/start', { method: 'POST', body: JSON.stringify({}) });
                    setNightWorkSessionId(session.id);
                  }, '야간근무 근태기록을 시작합니다.')
                }
              >
                야간근무 시작(근태)
              </button>
              <button
                style={{ margin: 0 }}
                className="secondary"
                disabled={!nightWorkSessionId}
                onClick={() =>
                  run(async () => {
                    await apiFetch('/night-work/end', { method: 'POST', body: JSON.stringify({ sessionId: nightWorkSessionId }) });
                    setNightWorkSessionId(null);
                  }, '야간근무를 종료했습니다. 대체휴무 전환 후보가 생성되었을 수 있습니다.')
                }
              >
                야간근무 종료(근태)
              </button>
            </div>
            <p style={{ fontSize: 11, color: '#adb5bd', marginTop: 8, marginBottom: 0 }}>
              * 위 "야간작업" 아이콘은 지금 상태 표시용이고, 여기는 대체휴무 전환용 실제 근무시간 기록입니다.
            </p>
          </div>
        </div>

        {/* 오른쪽 열: 고객사미팅/고객사작업/야간작업 상세입력 폼 (왼쪽 열과 높이를 맞춤) */}
        <div className="right-col-fill">
          {detailStatus && (
            <div className="card right-col-card">
              <h2>{STATUS_META[detailStatus].icon} {STATUS_META[detailStatus].label} 상세입력</h2>
              <label className="field-label">고객사명{detailStatus === 'NIGHT_WORK' ? '(내부 작업이면 비워두세요)' : ''}</label>
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="예: OO상사" />

              {EFFORT_STATUSES.has(detailStatus) && (
                <>
                  <label className="field-label">프로젝트명</label>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="예: 백업시스템 구축 2차" />
                </>
              )}

              <label className="field-label">작업 유형</label>
              <select className="field-select" value={workType} onChange={(e) => setWorkType(e.target.value)}>
                {WORK_TYPE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label">작업시작</label>
                  <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">작업완료(선택)</label>
                  <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} />
                </div>
              </div>

              <label className="field-label">작업내용</label>
              <textarea
                className="detail-textarea right-col-textarea"
                rows={3}
                placeholder="예: 서버 점검 및 백업 정책 협의"
                value={workDetail}
                onChange={(e) => setWorkDetail(e.target.value)}
              />
              <button disabled={!workDetail.trim()} onClick={submitDetailForm}>등록</button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
