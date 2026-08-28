import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, clearToken } from '@/lib/api';
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush } from '@/lib/push';
import { getCurrentLocation, distanceMeters, reverseGeocode } from '@/lib/geolocation';
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
  BUSINESS_TRIP: { label: '출장', icon: '✈️' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️' },
  ON_LEAVE: { label: '휴가', icon: '🌴' },
};
const STATUS_ORDER = ['REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'BUSINESS_TRIP', 'ALT_DAY_OFF', 'ON_LEAVE'];

// 이 상태들은 클릭 시 오른쪽에 상세입력 폼을 띄운다.
const DETAIL_FORM_STATUSES = new Set([
  'REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'BUSINESS_TRIP', 'ON_LEAVE', 'ALT_DAY_OFF',
]);
// 9개 아이콘 전부 동일한 규칙: 처음 누르면 상세폼 없이 즉시 등록되어 체크(✓) 표시가 바로 뜬다
// (상황판에도 즉시 반영). 이미 그 상태인데 같은 아이콘을 다시 누르면, 그때 상세폼이 열려서
// 날짜/장소/사유 같은 세부내용을 나중에 채워넣을 수 있다("우선 등록, 내용은 나중에" 원칙).
// 9개 항목 전부 클릭 즉시 상태변경(체크 표시)된다. 다만 이전 상태의 내용(note)을 아직 안 채웠는데
// 다른 상태로 넘어가려 하면 changeStatus()에서 막고 경고 후 그 상태의 입력폼을 대신 열어준다.
const QUICK_REGISTER_STATUSES = new Set(DETAIL_FORM_STATUSES);
// 이 상태들은 프로젝트별 공수(工數) 집계 대상이라 프로젝트명 필드가 필요하다.
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK']);
// 이 상태들은 "고객사명 + 업무내용"만 간단히 입력하는 단순폼이다(프로젝트/작업유형/시간 불필요).
const SIMPLE_CLIENT_STATUSES = new Set(['REMOTE', 'RESIDENT_ONSITE']);

const WORK_TYPE_OPTIONS = ['정기점검', '신규설치', '장애대응', '미팅', '기타'];
// 본사근무는 고객사 작업과 성격이 달라서(기술지원/셀프스터디 등) 별도 유형 목록을 쓴다.
const HQ_WORK_TYPE_OPTIONS = ['기술지원', '셀프스터디', '교육', '문서작성', '내부미팅', '기타'];
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

/** <input type="datetime-local">에 넣을 "지금" 기본값 (YYYY-MM-DDTHH:MM, 로컬시간 기준) */
function nowDateTimeLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="date">에 넣을 "오늘" 기본값 (YYYY-MM-DD, 로컬시간 기준) */
function todayDateLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  const [hqLocation, setHqLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showHqReturnPrompt, setShowHqReturnPrompt] = useState(false);
  const [showAltDayOffPrompt, setShowAltDayOffPrompt] = useState(false);
  const [clientLocations, setClientLocations] = useState<{ name: string; latitude: number; longitude: number }[]>([]);
  const [arrivedClient, setArrivedClient] = useState<string | null>(null);
  const hqPromptSnoozedUntilRef = useRef(0);
  const clientPromptSnoozedUntilRef = useRef(0);  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [myStatus, setMyStatus] = useState<MeAttendance | null>(null);
  const currentStatus = myStatus?.latestStatus;
  const clockedOut = Boolean(myStatus?.record?.clockOutAt);
  // 관리자 권한 계정은 퇴근 후에도 테스트할 수 있게 상태변경 잠금에서 예외로 둔다.
  const isAdminAccount = Boolean(me?.roles?.some((r) => ['SYSTEM_ADMIN', 'HR_ADMIN'].includes(r)));
  const [weekly, setWeekly] = useState<WeeklySummary | null>(null);

  // 고객사미팅/고객사작업/야간작업 공용 상세입력 폼 상태
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workStart, setWorkStart] = useState(nowHHMM());
  const [workEnd, setWorkEnd] = useState('');
  const [workType, setWorkType] = useState(WORK_TYPE_OPTIONS[0]);
  const [workDetail, setWorkDetail] = useState('');
  const [workReason, setWorkReason] = useState(''); // 육하원칙 중 "왜(목적/사유)"
  // 출장 전용 필드 (목적지/기간/목적)
  const [tripDestination, setTripDestination] = useState('');
  const [tripStart, setTripStart] = useState('');
  const [tripEnd, setTripEnd] = useState('');
  const [tripPurpose, setTripPurpose] = useState('');
  // 이동중 전용 필드 (출발지/목적지)
  const [movingFrom, setMovingFrom] = useState('');
  const [movingTo, setMovingTo] = useState('');
  // 휴가 전용 필드 (기간/행선지/비상연락처)
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [leaveDestination, setLeaveDestination] = useState('');
  const [leaveContact, setLeaveContact] = useState('');
  const detailFormRef = useRef<HTMLDivElement | null>(null);
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
        setMessageIsError(false);
      } else {
        await subscribeToPush();
        setPushSubscribed(true);
        setMessage('출근 알림을 켰습니다. 매일 오전 9시까지 상태를 등록하지 않으면 알려드립니다.');
        setMessageIsError(false);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '알림 설정에 실패했습니다.');
      setMessageIsError(true);
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

  // 본사 좌표를 한 번 불러온다(등록 안 돼있으면 아래 감지 자체를 안 함).
  useEffect(() => {
    apiFetch<{ latitude: number | null; longitude: number | null }>('/attendance/hq-location')
      .then((data) => {
        if (data.latitude != null && data.longitude != null) setHqLocation({ lat: data.latitude, lng: data.longitude });
      })
      .catch(() => {});
    apiFetch<{ name: string; latitude: number; longitude: number }[]>('/attendance/clients-with-location')
      .then(setClientLocations)
      .catch(() => {});
  }, []);

  // 5분마다 위치를 확인해서, 본사 근처인데 아직 "본사근무"가 아니면 복귀 알림을 띄운다.
  // 위치는 이 순간에만 잠깐 확인하고 서버로 보내지 않으며(브라우저 안에서만 거리 계산), 강제로 상태를
  // 바꾸지 않고 직원이 직접 확인 버튼을 눌러야 상태가 바뀐다.
  useEffect(() => {
    if (!me?.locationConsentGiven) return;
    const checkArrival = async () => {
      if (clockedOut) return;

      // "이동중" 상태면 등록된 고객사 근처 도착을 감지해서 고객사작업/미팅 등록을 제안한다.
      if (currentStatus?.status === 'MOVING' && clientLocations.length > 0 && Date.now() >= clientPromptSnoozedUntilRef.current) {
        const loc = await getCurrentLocation();
        if (loc) {
          const nearby = clientLocations.find((c) => distanceMeters(loc.lat, loc.lng, c.latitude, c.longitude) <= 300);
          if (nearby) { setArrivedClient(nearby.name); return; }
        }
      }

      // 본사 복귀 감지
      if (hqLocation && currentStatus?.status !== 'HQ_WORKING' && Date.now() >= hqPromptSnoozedUntilRef.current) {
        const loc = await getCurrentLocation();
        if (loc) {
          const dist = distanceMeters(loc.lat, loc.lng, hqLocation.lat, hqLocation.lng);
          if (dist <= 300) setShowHqReturnPrompt(true);
        }
      }
    };
    const interval = setInterval(checkArrival, 5 * 60 * 1000);
    const timeout = setTimeout(checkArrival, 30 * 1000); // 페이지 켠 직후에도 한 번 확인
    return () => { clearInterval(interval); clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hqLocation, clientLocations, me?.locationConsentGiven, currentStatus?.status, clockedOut]);

  async function run(action: () => Promise<unknown>, successMsg: string) {
    setMessage(null);
    setMessageIsError(false);
    try {
      await action();
      setMessage(successMsg);
      refreshMyStatus();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
      setMessageIsError(true);
    }
  }

  function openDetailForm(code: string, prefilledClientName?: string) {
    setDetailStatus(code);
    setClientName(prefilledClientName ?? (code === 'RESIDENT_ONSITE' ? (me?.assignedClient ?? '') : ''));
    setProjectName('');
    setWorkStart(nowHHMM());
    setWorkEnd('');
    setWorkType(code === 'HQ_WORKING' ? HQ_WORK_TYPE_OPTIONS[0] : WORK_TYPE_OPTIONS[0]);
    setWorkDetail('');
    setWorkReason('');
    setTripDestination('');
    setTripStart(nowDateTimeLocal());
    setTripEnd('');
    setTripPurpose('');
    setMovingFrom('');
    setMovingTo('');
    setLeaveStart(todayDateLocal());
    setLeaveEnd(todayDateLocal());
    setLeaveDestination('');
    setLeaveContact('');
    // 모바일에서 폼이 화면 아래로 밀려서 "아무 반응 없다"고 느껴지지 않게, 폼으로 스크롤을 옮겨준다.
    setTimeout(() => detailFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function changeStatus(code: string, prefilledClientName?: string) {
    const alreadyInThisStatus = currentStatus?.status === code;
    // 직전 상태의 내용을 아직 안 채운 채로 다른 상태로 넘어가는 경우, 막지는 않되(사용자가 화면에
    // 갇히면 안 되므로) "직전 것도 잊지 마세요" 정도의 부드러운 리마인더만 붙여준다.
    const pendingPrev = currentStatus && !currentStatus.note && !alreadyInThisStatus ? currentStatus : null;

    // 즉시등록 대상은 처음 누르면 상세폼 없이 바로 등록해서 상황판에 즉시 반영한다.
    // ("세부내용은 나중에 작성" — 시작하는 시점엔 아직 쓸 내용이 없는 게 당연하므로.)
    if (QUICK_REGISTER_STATUSES.has(code) && !alreadyInThisStatus) {
      const body: Record<string, unknown> = { status: code };
      if (['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK'].includes(code)) {
        body.effort = { clientName: prefilledClientName || undefined, startTime: nowHHMM() };
      }
      if (code === 'BUSINESS_TRIP') {
        body.businessTrip = { destination: '(추후 입력)', purpose: '(추후 입력)', startAt: new Date().toISOString() };
      }
      run(
        () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
        pendingPrev
          ? `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊 아래에서 세부내용을 입력해주세요. (직전 '${STATUS_META[pendingPrev.status]?.label ?? pendingPrev.status}' 내용도 잊지 말고 채워주세요!)`
          : `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊 아래에서 세부내용을 입력해주세요.`
      );
      // 상태변경과 동시에 세부내용 입력폼도 바로 아래에 띄운다(두 번 누를 필요 없게).
      openDetailForm(code, prefilledClientName);
      return;
    }

    if (DETAIL_FORM_STATUSES.has(code)) {
      openDetailForm(code, prefilledClientName);
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

    if (code === 'BUSINESS_TRIP') {
      if (!tripDestination.trim() || !tripStart || !tripPurpose.trim()) return;
      const note = `목적지: ${tripDestination} | 출발: ${tripStart}${tripEnd ? ` | 복귀예정: ${tripEnd}` : ' | 복귀예정 미정'} | 목적: ${tripPurpose}`;
      const body = {
        status: code,
        note,
        businessTrip: { destination: tripDestination, purpose: tripPurpose, startAt: tripStart, endAt: tripEnd || undefined },
      };
      run(() => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }), `출장(${tripDestination})이 등록되었습니다. 😊`);
      setDetailStatus(null);
      return;
    }

    if (code === 'ON_LEAVE') {
      if (!leaveStart || !leaveEnd) return;
      const note = `휴가기간: ${leaveStart} ~ ${leaveEnd}${leaveDestination ? ` | 행선지: ${leaveDestination}` : ''}${leaveContact ? ` | 비상연락처: ${leaveContact}` : ''}`;
      run(() => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code, note }) }), '휴가가 등록되었습니다. 😊');
      setDetailStatus(null);
      return;
    }

    if (code === 'ALT_DAY_OFF') {
      if (!leaveStart) return;
      const note = `대체휴무: ${leaveStart}${leaveEnd ? ` ~ ${leaveEnd}` : ''}${leaveDestination ? ` | 사유: ${leaveDestination}` : ''}`;
      run(() => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code, note }) }), '대체휴무가 등록되었습니다. 😊');
      setDetailStatus(null);
      return;
    }

    if (code === 'MOVING') {
      if (!movingFrom.trim() || !movingTo.trim()) return;
      const note = `${movingFrom} → ${movingTo}`;
      run(() => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code, note }) }), '이동경로가 등록되었습니다. 😊');
      setDetailStatus(null);
      return;
    }

    if (SIMPLE_CLIENT_STATUSES.has(code)) {
      if (!workDetail.trim()) return;
      const note = code === 'REMOTE'
        ? `지원고객사: ${clientName || '-'} | 업무내용: ${workDetail}`
        : `고객사: ${clientName || '-'} | 업무내용: ${workDetail}`;
      run(() => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify({ status: code, note }) }), `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊`);
      setDetailStatus(null);
      return;
    }

    const note = `유형: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 내용: ${workDetail} | 목적: ${workReason}`;
    const body: Record<string, unknown> = { status: code, note };
    if (DETAIL_FORM_STATUSES.has(code)) {
      body.effort = {
        clientName,
        projectName,
        workType,
        startTime: workStart,
        endTime: workEnd || undefined,
        description: `${workDetail} (목적: ${workReason})`,
      };
    }
    // 고객사미팅/고객사작업은 등록 순간 위치를 확인해서 등록된 고객사 위치와 대조한다(동의한 경우에만).
    if (EFFORT_STATUSES.has(code) && me?.locationConsentGiven) {
      const loc = await getCurrentLocation();
      if (loc) body.location = loc;
    }

    if (code === 'NIGHT_WORK') {
      // 야간작업 완료 등록은 응답의 대체휴무 권고 여부를 바로 확인해야 해서 run()을 안 거치고 직접 호출한다.
      setMessage(null);
      setMessageIsError(false);
      try {
        const res = await apiFetch<{ statusLog: unknown; nightWork: { altDayOffRecommended?: boolean } | null }>(
          '/attendance/status', { method: 'POST', body: JSON.stringify(body) }
        );
        setMessage(`상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊`);
        refreshMyStatus();
        if (res.nightWork?.altDayOffRecommended) setShowAltDayOffPrompt(true);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
        setMessageIsError(true);
      }
      setDetailStatus(null);
      return;
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
          <h1 style={{ marginBottom: 0 }}>DSTI-TSB</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdminAccount && (
            <button
              className="secondary"
              style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }}
              onClick={() => router.push('/admin/dashboard')}
            >
              관리자 화면
            </button>
          )}
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

      {arrivedClient && (
        <div className="card col-full" style={{ background: '#eaf1ff', border: '1px solid #2f6feb' }}>
          🚗 <strong>{arrivedClient}</strong>에 도착하신 것 같아요! 어떤 걸로 등록할까요?
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={{ width: 'auto', margin: 0 }} onClick={() => { const c = arrivedClient; setArrivedClient(null); changeStatus('CLIENT_WORK', c); }}>
              🛠️ 고객사작업
            </button>
            <button style={{ width: 'auto', margin: 0 }} onClick={() => { const c = arrivedClient; setArrivedClient(null); changeStatus('CLIENT_MEETING', c); }}>
              🤝 고객사미팅
            </button>
            <button
              className="secondary"
              style={{ width: 'auto', margin: 0 }}
              onClick={() => { setArrivedClient(null); clientPromptSnoozedUntilRef.current = Date.now() + 60 * 60 * 1000; }}
            >
              아니요
            </button>
          </div>
        </div>
      )}

      {showAltDayOffPrompt && (
        <div className="card col-full" style={{ background: '#eaf1ff', border: '1px solid #2f6feb' }}>
          🌙 오늘 저녁 9시 이후 6시간 이상 야간근무 하셨네요! 대체휴무로 전환해두시겠어요? (관리자 승인 후 최종 확정됩니다)
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              style={{ width: 'auto', margin: 0 }}
              onClick={() => {
                setShowAltDayOffPrompt(false);
                changeStatus('ALT_DAY_OFF');
              }}
            >
              네, 대체휴무 등록할게요
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setShowAltDayOffPrompt(false)}>
              나중에요
            </button>
          </div>
        </div>
      )}

      {showHqReturnPrompt && (
        <div className="card col-full" style={{ background: '#eaf1ff', border: '1px solid #2f6feb' }}>
          🏢 본사에 도착하신 것 같아요! 상태를 "본사근무"로 바꾸시겠어요?
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              style={{ width: 'auto', margin: 0 }}
              onClick={() => {
                setShowHqReturnPrompt(false);
                changeStatus('HQ_WORKING');
              }}
            >
              네, 본사근무로 바꿀게요
            </button>
            <button
              className="secondary"
              style={{ width: 'auto', margin: 0 }}
              onClick={() => {
                setShowHqReturnPrompt(false);
                hqPromptSnoozedUntilRef.current = Date.now() + 60 * 60 * 1000; // 1시간 동안 다시 안 물어봄
              }}
            >
              아니요, 아직이에요
            </button>
          </div>
        </div>
      )}

      {message && (
        <div
          className="card col-full"
          style={{
            background: message.startsWith('⚠️') || messageIsError ? '#fff4e6' : '#eef7ee',
            color: message.startsWith('⚠️') || messageIsError ? '#e8590c' : undefined,
            fontWeight: message.startsWith('⚠️') || messageIsError ? 600 : undefined,
          }}
        >
          {message}
        </div>
      )}

      <div className="employee-grid">
        {/* 왼쪽 열 */}
        <div>
          <div className="card">
            <h2>출퇴근</h2>
            <button
              className={myStatus?.record?.clockInAt ? 'done' : ''}
              disabled={Boolean(myStatus?.record?.clockInAt)}
              onClick={() =>
                run(async () => {
                  let location: { lat: number; lng: number } | undefined;
                  if (me?.locationConsentGiven) {
                    const loc = await getCurrentLocation();
                    if (loc) location = loc;
                  }
                  return apiFetch('/attendance/clock-in', { method: 'POST', body: JSON.stringify(location ? { location } : {}) });
                }, '출근 처리되었습니다.')
              }
            >
              {myStatus?.record?.clockInAt ? `✓ 출근 완료 · ${fmtClock(myStatus.record.clockInAt)}` : '출근'}
            </button>
            <button
              className={myStatus?.record?.clockOutAt ? 'done' : 'secondary'}
              disabled={!myStatus?.record?.clockInAt || Boolean(myStatus?.record?.clockOutAt)}
              onClick={() =>
                run(async () => {
                  let locationAddress: string | undefined;
                  if (me?.locationConsentGiven) {
                    const loc = await getCurrentLocation();
                    if (loc) locationAddress = (await reverseGeocode(loc.lat, loc.lng)) ?? undefined;
                  }
                  return apiFetch('/attendance/clock-out', { method: 'POST', body: JSON.stringify(locationAddress ? { locationAddress } : {}) });
                }, '퇴근 처리되었습니다. 오늘도 수고하셨어요!')
              }
            >
              {myStatus?.record?.clockOutAt ? `✓ 퇴근 완료 · ${fmtClock(myStatus.record.clockOutAt)}` : '퇴근'}
            </button>
            <p style={{ fontSize: 11, color: '#adb5bd', marginTop: 4, marginBottom: 8 }}>
              * "본사근무/고객사상주/고객사미팅/고객사작업" 상태로 바꾸거나 도착체크를 하면 출근시각이 자동으로 기록됩니다. 퇴근 버튼을 눌러야 그날 근무가 확정됩니다.
              <br />⚠️ <strong>본사를 거치지 않고 고객사로 바로 출근(직출)하는 날은 "출근" 버튼을 먼저 누르지 마세요.</strong> 이동시간은 근로시간에 포함되지 않으므로, 고객사 도착 후 "고객사작업/고객사미팅"을 눌러야 그 시점부터 정확히 근무시간이 계산됩니다.
            </p>
            <button className="secondary" disabled={pushLoading} onClick={togglePush}>
              {pushLoading ? '처리 중...' : pushSubscribed ? '🔔 출근 알림 끄기' : '🔕 출근 알림 켜기(오전 9시)'}
            </button>
          </div>

          <div className="card">
            <h2>지금 뭐 하고 계세요?</h2>
            {clockedOut && !isAdminAccount && (
              <div className="board-empty" style={{ marginBottom: 8, color: '#f08c00', fontWeight: 600 }}>
                🔒 퇴근 처리되어 상태를 더 이상 바꿀 수 없습니다 (야간작업은 계속 등록 가능해요). 내일 다시 만나요!
              </div>
            )}
            {clockedOut && isAdminAccount && (
              <div className="board-empty" style={{ marginBottom: 8, color: '#868e96' }}>
                🔓 관리자 계정이라 퇴근 후에도 계속 상태를 테스트하실 수 있어요.
              </div>
            )}
            <div className="status-icon-grid">
              {STATUS_ORDER.map((code) => {
                // 퇴근(낮근무 종료) 후에도 야간작업자는 계속 상태를 등록해야 하니 예외로 둔다.
                const isLocked = clockedOut && code !== 'NIGHT_WORK' && !isAdminAccount;
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

        {/* 오른쪽 열: 상태별 상세입력 폼 (왼쪽 열과 높이를 맞춤) */}
        <div className="right-col-fill" ref={detailFormRef}>
          {detailStatus === 'BUSINESS_TRIP' && (
            <div className="card right-col-card">
              <h2>✈️ 출장 등록</h2>
              <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                * 목적지·출발일시·목적은 필수입니다. 복귀예정일시는 몰라도 비워두고 등록 가능합니다.
              </p>
              <label className="field-label">목적지</label>
              <input value={tripDestination} onChange={(e) => setTripDestination(e.target.value)} placeholder="예: 부산 OO데이터센터" />

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label">출발 일시</label>
                  <input type="datetime-local" value={tripStart} onChange={(e) => setTripStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">복귀 예정 일시(선택)</label>
                  <input type="datetime-local" value={tripEnd} onChange={(e) => setTripEnd(e.target.value)} />
                </div>
              </div>

              <label className="field-label">목적</label>
              <textarea
                className="detail-textarea right-col-textarea"
                rows={3}
                placeholder="예: OO데이터센터 서버 이전 작업 지원"
                value={tripPurpose}
                onChange={(e) => setTripPurpose(e.target.value)}
              />
              <button disabled={!tripDestination.trim() || !tripStart || !tripPurpose.trim()} onClick={submitDetailForm}>
                등록
              </button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}

          {detailStatus === 'ON_LEAVE' && (
            <div className="card right-col-card">
              <h2>🌴 휴가 등록</h2>
              <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                * 휴가 시작일·종료일은 필수입니다. 행선지·비상연락처는 남겨두시면 급한 연락에 도움이 됩니다.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label">시작일</label>
                  <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">종료일</label>
                  <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} />
                </div>
              </div>
              <label className="field-label">행선지(선택)</label>
              <input value={leaveDestination} onChange={(e) => setLeaveDestination(e.target.value)} placeholder="예: 제주도, 국내(자택)" />
              <label className="field-label">비상연락처(선택)</label>
              <input value={leaveContact} onChange={(e) => setLeaveContact(e.target.value)} placeholder="예: 010-1234-5678" />
              <button disabled={!leaveStart || !leaveEnd} onClick={submitDetailForm}>등록</button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}

          {detailStatus === 'ALT_DAY_OFF' && (
            <div className="card right-col-card">
              <h2>🏖️ 대체휴무 등록</h2>
              <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                * 대체휴무 사용일은 필수입니다. 여러 날 쓰신다면 종료일도 같이 넣어주세요.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label">시작일</label>
                  <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">종료일(선택 — 하루면 비워두세요)</label>
                  <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} />
                </div>
              </div>
              <label className="field-label">사유(선택)</label>
              <input value={leaveDestination} onChange={(e) => setLeaveDestination(e.target.value)} placeholder="예: 지난주 야간작업 대체" />
              <button disabled={!leaveStart} onClick={submitDetailForm}>등록</button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}

          {detailStatus === 'MOVING' && (
            <div className="card right-col-card">
              <h2>🚙 이동경로 추가</h2>
              <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                * 어디서 어디로 이동하시는지 남겨주세요. 등록하면 바로 "이동중" 상태로 반영됩니다.
              </p>
              <label className="field-label">출발지</label>
              <input value={movingFrom} onChange={(e) => setMovingFrom(e.target.value)} placeholder="예: 본사" />
              <label className="field-label">목적지</label>
              <input value={movingTo} onChange={(e) => setMovingTo(e.target.value)} placeholder="예: OO상사" />
              <button disabled={!movingFrom.trim() || !movingTo.trim()} onClick={submitDetailForm}>등록</button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}

          {detailStatus && SIMPLE_CLIENT_STATUSES.has(detailStatus) && (
            <div className="card right-col-card">
              <h2>{STATUS_META[detailStatus].icon} {STATUS_META[detailStatus].label} 등록</h2>
              <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                * {detailStatus === 'REMOTE' ? '어떤 고객을 지원하고 계신지 남겨주세요.' : '어떤 업무로 상주 중이신지 남겨주세요.'} 등록하면 바로 상태가 반영됩니다.
              </p>
              <label className="field-label">{detailStatus === 'REMOTE' ? '지원 고객사' : '고객사명'}</label>
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="예: OO상사" />
              <label className="field-label">업무내용(무엇을/어떻게 — 최소 10자)</label>
              <textarea
                className="detail-textarea right-col-textarea"
                rows={3}
                placeholder={detailStatus === 'REMOTE' ? '예: OO상사 방화벽 원격 장애대응 진행' : '예: 서버 정기점검 및 모니터링 대시보드 확인'}
                value={workDetail}
                onChange={(e) => setWorkDetail(e.target.value)}
              />
              <button disabled={workDetail.trim().length < 10} onClick={submitDetailForm}>등록</button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}

          {detailStatus && !SIMPLE_CLIENT_STATUSES.has(detailStatus) && !['BUSINESS_TRIP', 'ON_LEAVE', 'ALT_DAY_OFF', 'MOVING'].includes(detailStatus) && (
            <div className="card right-col-card">
              <h2>{STATUS_META[detailStatus].icon} {detailStatus === 'HQ_WORKING' ? '본사근무 업무일지' : QUICK_REGISTER_STATUSES.has(detailStatus) ? `${STATUS_META[detailStatus].label} 내용 추가` : `${STATUS_META[detailStatus].label} 등록`}</h2>
              {QUICK_REGISTER_STATUSES.has(detailStatus) ? (
                <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                  * 이미 '{STATUS_META[detailStatus].label}'(으)로 등록되어 있습니다. 작업이 마무리됐으면 여기서 내용/완료시간을 채워주세요.
                </p>
              ) : (
                <p style={{ fontSize: 12, color: '#868e96', marginTop: -4, marginBottom: 10 }}>
                  * 내용을 입력하고 등록하면 바로 '{STATUS_META[detailStatus].label}' 상태로 반영됩니다. 완료시간은 몰라도(진행중이면) 비워두고 등록 가능합니다.
                </p>
              )}
              <label className="field-label">
                {detailStatus === 'HQ_WORKING' ? '관련 프로젝트/고객사(선택)' : '고객사명'}
                {detailStatus === 'NIGHT_WORK' ? '(내부 작업이면 비워두세요)' : ''}
              </label>
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="예: OO상사" />

              {EFFORT_STATUSES.has(detailStatus) && (
                <>
                  <label className="field-label">프로젝트명{detailStatus === 'HQ_WORKING' ? '(선택)' : ''}</label>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="예: 백업시스템 구축 2차" />
                </>
              )}

              <label className="field-label">작업 유형</label>
              <select className="field-select" value={workType} onChange={(e) => setWorkType(e.target.value)}>
                {(detailStatus === 'HQ_WORKING' ? HQ_WORK_TYPE_OPTIONS : WORK_TYPE_OPTIONS).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label">작업시작</label>
                  <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">작업완료(선택 — 진행중이면 비워두세요)</label>
                  <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} />
                </div>
              </div>

              <label className="field-label">{detailStatus === 'HQ_WORKING' ? '오늘 수행업무(무엇을/어떻게 — 최소 10자)' : '작업내용(무엇을/어떻게 — 최소 10자)'}</label>
              <textarea
                className="detail-textarea right-col-textarea"
                rows={3}
                placeholder={detailStatus === 'HQ_WORKING' ? '예: 기술지원으로 백업 정책서를 신규 작성했음' : '예: 서버 3대 정기점검 후 백업 정책을 재협의함'}
                value={workDetail}
                onChange={(e) => setWorkDetail(e.target.value)}
              />
              <label className="field-label">목적/사유(왜)</label>
              <input
                value={workReason}
                onChange={(e) => setWorkReason(e.target.value)}
                placeholder="예: 정기 유지보수 계약에 따른 월간 점검"
              />
              <button
                disabled={workDetail.trim().length < 10 || !workReason.trim() || !workStart}
                onClick={submitDetailForm}
              >
                등록
              </button>
              <button className="secondary" onClick={() => setDetailStatus(null)}>취소</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
