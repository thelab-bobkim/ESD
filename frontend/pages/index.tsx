import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, clearToken } from '@/lib/api';
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush } from '@/lib/push';
import { getCurrentLocation } from '@/lib/geolocation';
import LocationConsentModal from '@/components/LocationConsentModal';

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
const WEEKLY_LIMIT_MINUTES = 52 * 60;

interface MeResponse {
  name: string; email: string; roles: string[]; workType: string; department: string; assignedClient: string | null; mustChangePassword: boolean; locationConsentGiven: boolean;
}
interface StatusLog { status: string; changedAt: string; source: string; note: string | null; }
interface MeAttendance { record: { clockInAt: string | null; clockOutAt: string | null } | null; latestStatus: StatusLog | null; }
interface WeeklySummary { from: string; to: string; totalMinutes: number; days: number; }

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function greetingByHour(): string {
  const h = new Date().getHours();
  if (h < 6) return '늦은 시간까지 고생 많으세요';
  if (h < 12) return '좋은 아침이에요';
  if (h < 14) return '점심은 맛있게 드셨나요';
  if (h < 19) return '오늘도 수고 많으세요';
  return '오늘 하루도 고생하셨어요';
}

function timeAgoShort(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}시간 ${remMin}분 전` : `${hr}시간 전`;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

export default function EmployeeHome() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [showLocationConsent, setShowLocationConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [myStatus, setMyStatus] = useState<MeAttendance | null>(null);
  const [weekly, setWeekly] = useState<WeeklySummary | null>(null);

  // 고객사미팅/고객사작업/야간작업 공용 상세입력 폼 상태
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workStart, setWorkStart] = useState(nowHHMM());
  const [workEnd, setWorkEnd] = useState('');
  const [workType, setWorkType] = useState(WORK_TYPE_OPTIONS[0]);
  const [workDetail, setWorkDetail] = useState('');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  function refreshMyStatus() {
    apiFetch<MeAttendance>('/attendance/me').then(setMyStatus).catch(() => {});
    apiFetch<WeeklySummary>('/attendance/me/weekly').then(setWeekly).catch(() => {});
  }

  useEffect(() => {
    isPushSubscribed().then(setPushSubscribed).catch(() => {});
  }, []);

  async function togglePush() {
    setPushLoading(true);
    try {
      if (pushSubscribed) {
        await unsubscribeFromPush();
        setPushSubscribed(false);
        setMessage('출근 알림을 껐습니다.');
      } else {
        await subscribeToPush();
        setPushSubscribed(true);
        setMessage('출근 알림을 켰습니다. 매일 오전 9시까지 상태를 등록하지 않으면 알려드립니다.');
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '알림 설정에 실패했습니다.');
    } finally {
      setPushLoading(false);
    }
  }

  useEffect(() => {
    apiFetch<MeResponse>('/auth/me')
      .then((data) => {
        if (data.mustChangePassword) {
          router.push('/change-password');
          return;
        }
        setMe(data);
        setShowLocationConsent(!data.locationConsentGiven);
        refreshMyStatus();
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function run(action: () => Promise<unknown>, successMsg: string) {
    setMessage(null);
    try {
      await action();
      setMessage(successMsg);
      refreshMyStatus();
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
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊`
    );
  }

  async function submitDetailForm() {
    if (!detailStatus) return;
    const code = detailStatus;
    const note = `유형: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 내용: ${workDetail}`;
    const body: Record<string, unknown> = { status: code, note };
    if (DETAIL_FORM_STATUSES.has(code)) {
      body.effort = {
        clientName,
        projectName,
        workType,
        startTime: workStart,
        endTime: workEnd || undefined,
        description: workDetail,
      };
    }
    // 고객사미팅/고객사작업은 등록 순간 위치를 확인해서 등록된 고객사 위치와 대조한다(동의한 경우에만).
    if (EFFORT_STATUSES.has(code) && me?.locationConsentGiven) {
      const loc = await getCurrentLocation();
      if (loc) body.location = loc;
    }
    run(
      () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊`
    );
    setDetailStatus(null);
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  const weeklyPct = useMemo(() => {
    if (!weekly) return 0;
    return Math.min(100, Math.round((weekly.totalMinutes / WEEKLY_LIMIT_MINUTES) * 100));
  }, [weekly]);
  const weeklyOver = weekly ? weekly.totalMinutes > WEEKLY_LIMIT_MINUTES : false;

  if (!me) return <div className="page">불러오는 중...</div>;

  const currentStatus = myStatus?.latestStatus;
  const clockedOut = Boolean(myStatus?.record?.clockOutAt);

  return (
    <div className="employee-shell">
      <Head>
        <title>기술부 현황 등록</title>
      </Head>

      {showLocationConsent && (
        <LocationConsentModal
          onDone={(consented) => {
            setShowLocationConsent(false);
            if (consented) setMe((prev) => (prev ? { ...prev, locationConsentGiven: true } : prev));
          }}
        />
      )}

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

      {/* 히어로: 인사말 + 지금 내 상태 크게 보여주기 */}
      <div className="hero-card">
        <div className="hero-greeting">{me.name}님, {greetingByHour()}! 👋</div>
        {currentStatus ? (
          <div className="hero-status">
            <span className="hero-status-icon">{STATUS_META[currentStatus.status]?.icon ?? '❔'}</span>
            <div>
              <div className="hero-status-label">지금 상태: {STATUS_META[currentStatus.status]?.label ?? currentStatus.status}</div>
              <div className="hero-status-time">{timeAgoShort(currentStatus.changedAt)}에 등록됨</div>
            </div>
          </div>
        ) : (
          <div className="hero-nudge">
            🌤️ 아직 오늘 상태를 등록 안 하셨네요! 아래에서 지금 상태를 눌러주세요 — 10초면 끝나요.
          </div>
        )}

        {weekly && (
          <div className="weekly-gauge">
            <div className="weekly-gauge-label">
              <span>이번주 내 근무시간</span>
              <span style={{ color: weeklyOver ? '#e03131' : '#2f9e44', fontWeight: 700 }}>{hoursLabel(weekly.totalMinutes)}</span>
            </div>
            <div className="weekly-gauge-track">
              <div className="weekly-gauge-fill" style={{ width: `${weeklyPct}%`, background: weeklyOver ? '#e03131' : '#2f6feb' }} />
            </div>
            <div className="weekly-gauge-sub">
              {weeklyOver ? '⚠ 주 52시간을 넘었어요, 컨디션 챙기세요' : `주 52시간 중 ${weeklyPct}% — 스스로 페이스를 확인해보세요`}
            </div>
          </div>
        )}
      </div>

      {message && <div className="card col-full" style={{ background: '#eef7ee' }}>{message}</div>}

      <div className="employee-grid">
        {/* 왼쪽 열 */}
        <div>
          <div className="card">
            <h2>출퇴근</h2>
            <button
              className={myStatus?.record?.clockInAt ? 'done' : ''}
              disabled={Boolean(myStatus?.record?.clockInAt)}
              onClick={() => run(() => apiFetch('/attendance/clock-in', { method: 'POST' }), '출근 처리되었습니다.')}
            >
              {myStatus?.record?.clockInAt ? `✓ 출근 완료 · ${fmtClock(myStatus.record.clockInAt)}` : '출근'}
            </button>
            <button
              className={myStatus?.record?.clockOutAt ? 'done' : 'secondary'}
              disabled={!myStatus?.record?.clockInAt || Boolean(myStatus?.record?.clockOutAt)}
              onClick={() => run(() => apiFetch('/attendance/clock-out', { method: 'POST' }), '퇴근 처리되었습니다. 오늘도 수고하셨어요!')}
            >
              {myStatus?.record?.clockOutAt ? `✓ 퇴근 완료 · ${fmtClock(myStatus.record.clockOutAt)}` : '퇴근'}
            </button>
            <p style={{ fontSize: 11, color: '#adb5bd', marginTop: 4, marginBottom: 8 }}>
              * "본사근무/고객사상주/고객사미팅/고객사작업" 상태로 바꾸거나 도착체크를 하면 출근시각이 자동으로 기록됩니다. 퇴근 버튼을 눌러야 그날 근무가 확정됩니다.
            </p>
            <button className="secondary" disabled={pushLoading} onClick={togglePush}>
              {pushLoading ? '처리 중...' : pushSubscribed ? '🔔 출근 알림 끄기' : '🔕 출근 알림 켜기(오전 9시)'}
            </button>
          </div>

          <div className="card">
            <h2>지금 뭐 하고 계세요?</h2>
            {clockedOut && (
              <div className="board-empty" style={{ marginBottom: 8, color: '#f08c00', fontWeight: 600 }}>
                🔒 퇴근 처리되어 상태를 더 이상 바꿀 수 없습니다 (야간작업은 계속 등록 가능해요). 내일 다시 만나요!
              </div>
            )}
            <div className="status-icon-grid">
              {STATUS_ORDER.map((code) => {
                // 퇴근(낮근무 종료) 후에도 야간작업자는 계속 상태를 등록해야 하니 예외로 둔다.
                const isLocked = clockedOut && code !== 'NIGHT_WORK';
                return (
                  <div
                    key={code}
                    className={`status-icon-btn${currentStatus?.status === code ? ' active' : ''}${isLocked ? ' locked' : ''}`}
                    onClick={() => !isLocked && changeStatus(code)}
                  >
                    <div className="status-icon-emoji">{STATUS_META[code].icon}</div>
                    <div className="status-icon-label">{STATUS_META[code].label}</div>
                    {currentStatus?.status === code && <div className="status-icon-check">✓</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {me.assignedClient && (
            <div className="card">
              <h2>고객사 상주 도착체크</h2>
              <button
                onClick={() =>
                  run(async () => {
                    const loc = me?.locationConsentGiven ? await getCurrentLocation() : null;
                    return apiFetch('/resident/checkin', { method: 'POST', body: JSON.stringify(loc ? { location: loc } : {}) });
                  }, '도착체크가 완료되었습니다.')
                }
              >
                도착체크
              </button>
              <button className="secondary" onClick={() => run(() => apiFetch('/resident/confirm', { method: 'POST' }), '현재 상태를 재확인했습니다.')}>상태 재확인</button>
            </div>
          )}
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
