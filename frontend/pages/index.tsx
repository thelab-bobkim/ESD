import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, clearToken } from '@/lib/api';
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush, isIOSDevice, isStandalonePWA } from '@/lib/push';
import { getCurrentLocation, getCurrentLocationWithStatus, distanceMeters, reverseGeocode, isLowAccuracy, accuracyWarningLabel } from '@/lib/geolocation';
import { heroGreeting, clockOutGreeting, type WeatherInfo } from '@/lib/greetings';
import MandatoryConsentGate from '@/components/MandatoryConsentGate';
import ClockOutConfirmModal from '@/components/ClockOutConfirmModal';
import PastDayCorrectionCard, { type PendingCorrectionRow } from '@/components/PastDayCorrectionCard';

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
// 2026-09-02: 고객사미팅/고객사작업은 예외 — 어떤 고객사인지 모르면 등록해봐야 리포트에서
// 쓸모가 없어서(공수 산정 불가), 이 두 개만 즉시등록에서 빼고 항상 고객사 선택 폼을 먼저 연다
// (백엔드도 이 두 상태는 clientName을 필수로 요구하도록 함께 바꿈 — 사용자 확인 완료).
const QUICK_REGISTER_STATUSES = new Set(
  Array.from(DETAIL_FORM_STATUSES).filter((s) => s !== 'CLIENT_MEETING' && s !== 'CLIENT_WORK')
);
// 이 상태들은 프로젝트별 공수(工數) 집계 대상이라 프로젝트명 필드가 필요하다.
// REMOTE(재택)는 대부분 고객사에 원격 접속해서 작업하므로, 고객사작업과 동일하게 접속시작~종료를
// 추적한다(백엔드 EFFORT_STATUSES와 반드시 같은 값을 유지해야 한다).
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE']);
// 이 상태들은 "고객사명 + 업무내용"만 간단히 입력하는 단순폼이다(프로젝트/작업유형/시간 불필요).
// REMOTE는 접속시작~종료를 추적해야 해서 여기서 뺐다(2026-08-30, 엔지니어 공수 리포트 누락 문제 해결).
const SIMPLE_CLIENT_STATUSES = new Set(['RESIDENT_ONSITE']);
// 이 상태들은 "작업위치(원격/현장)"를 필수로, "작업인원/진행률·차수"를 선택으로 받는다 —
// 백업팀 등의 야간/고객사 작업 보고서 형식(예: VERITAS 야간작업 보고 메일)을 참고해 추가한 필드.
// 백엔드 attendance.routes.ts의 REQUIRE_SITE_TYPE_STATUSES와 반드시 같은 값을 유지해야 한다.
const SITE_DETAIL_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK']);
// 백엔드 LOCATION_CHECK_STATUSES와 동일 — 이 상태들만 등록 순간 좌표를 등록된 고객사와 대조한다.
const LOCATION_CHECK_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);
// 2026-09-01: 직원들이 등록을 귀찮아해서(항목이 너무 많음) 본사근무/고객사미팅/고객사작업 세 가지는
// 입력폼을 간소화했다 — 프로젝트명/목적·사유/진행률·차수 같은 부가 항목을 없애고, 실제로 꼭 필요한
// 항목(고객사·관련프로젝트, 수행업무)만 채우면 바로 등록되게 했다. 야간작업/재택은 기존 그대로 유지.
// 2026-09-01: 재택/야간작업도 같은 이유로 고객사작업과 같은 간소화된 형식으로 맞췄다 —
// 목적/사유 항목을 없애고, 진행률/차수(야간작업에만 있던 항목)도 없애서 형식을 통일했다.
const SIMPLIFIED_EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'NIGHT_WORK']);

const WORK_TYPE_OPTIONS = ['정기점검', '신규설치', '장애대응', '미팅', '기타'];
// 고객사미팅은 "작업"이 아니라 "미팅"이라 유형 대신 목적으로 구분한다.
const MEETING_PURPOSE_OPTIONS = ['백업미팅', '식사', '신규방문', '프로젝트미팅', '기타'];
// 본사근무는 고객사 작업과 성격이 달라서(기술지원/셀프스터디 등) 별도 유형 목록을 쓴다.
const HQ_WORK_TYPE_OPTIONS = ['기술지원', '셀프스터디', '교육', '문서작성', '내부미팅', '기타'];
const WEEKLY_LIMIT_MINUTES = 52 * 60;
// 상태 아이콘을 잘못 눌렀을 때 흔적 없이 취소할 수 있는 "되돌리기" 허용 시간(2026-09-04) —
// 백엔드 /attendance/status/undo 의 UNDO_WINDOW_MS와 반드시 같은 값을 유지해야 한다.
const UNDO_WINDOW_MS = 10 * 60 * 1000;
// 마지막 근무위치(본사/고객사)를 이만큼 계속 벗어나 있으면 퇴근 제안을 만든다(2026-09-04).
const DEPARTURE_AWAY_THRESHOLD_MS = 30 * 60 * 1000;

// 부서별로 (1) 9개 상태 아이콘 중 실제로 보여줄 것, (2) 그중 등록만 하고 세부입력폼은 아예
// 열지 않을 것을 다르게 설정한다(2026-09-04, 경영관리부 요청 — "본사출근은 확인만 하면 되고,
// 고객사 관련 상태는 애초에 안 보여도 된다"). 부서명은 다우오피스 동기화 부서명과 정확히
// 일치해야 하며, 여기 없는 부서는 기존과 동일하게 전체 상태 + 세부폼을 그대로 유지한다.
// 다른 부서도 필요해지면 이 맵에 항목만 추가하면 된다.
type StatusOverride = { visibleStatuses: string[]; noFormStatuses: string[] };

// 2026-09-04: 보안/솔루션/arctera/Cohesity/BlL/DX/Pre-Sales사업부(엔지니어링 계열) 요청 —
// 재택·본사근무는 버튼은 남기되 입력폼 없이 클릭만으로 등록되고, 그 외엔 고객사상주·이동중·
// 고객사미팅·야간작업·출장·휴가만 있으면 된다(고객사작업/대체휴무는 안 보임 — 이 팀들은 고객사
// 방문 시 "고객사상주"로 등록하고 별도 "고객사작업"은 안 쓴다는 전제).
const FIELD_ENGINEERING_OVERRIDE: StatusOverride = {
  visibleStatuses: ['REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'NIGHT_WORK', 'BUSINESS_TRIP', 'ON_LEAVE'],
  noFormStatuses: ['REMOTE', 'HQ_WORKING'],
};

const DEPARTMENT_STATUS_OVERRIDES: Record<string, StatusOverride> = {
  경영관리부: {
    visibleStatuses: ['REMOTE', 'HQ_WORKING', 'MOVING', 'BUSINESS_TRIP', 'ON_LEAVE'],
    noFormStatuses: ['HQ_WORKING'],
  },
  보안사업부: FIELD_ENGINEERING_OVERRIDE,
  솔루션사업부: FIELD_ENGINEERING_OVERRIDE,
  arctera사업부: FIELD_ENGINEERING_OVERRIDE,
  Cohesity사업부: FIELD_ENGINEERING_OVERRIDE,
  BlL사업부: FIELD_ENGINEERING_OVERRIDE,
  DX사업부: FIELD_ENGINEERING_OVERRIDE,
  // 다우오피스 동기화 부서명이 대시보드에 "Pre-Sales사업부"(대문자 S)로 표시되는 걸 확인해서
  // 그 표기를 그대로 맞췄다(요청 메시지의 "Pre-sales"와 대소문자가 다름 — 정확히 일치해야
  // 적용되므로 실제 동기화 표기를 우선했다).
  'Pre-Sales사업부': FIELD_ENGINEERING_OVERRIDE,
};

// 부서와 무관하게 특정 개인에게 적용하는 예외(2026-09-04, 이종갑님 요청 — 부서 소속과 별개로
// 개인별로 지정). 부서 설정보다 우선한다. 이름으로 매칭하므로, 동명이인이 있으면 둘 다 적용될
// 수 있다는 점은 감안해야 한다(사번으로 바꾸려면 /auth/me 응답에 사번을 추가해야 함).
const USER_STATUS_OVERRIDES: Record<string, StatusOverride> = {
  이종갑: FIELD_ENGINEERING_OVERRIDE,
};

interface MeResponse {
  name: string; email: string; roles: string[]; workType: string; department: string; assignedClient: string | null; mustChangePassword: boolean; locationConsentGiven: boolean; privacyConsentGiven: boolean;
}
interface StatusLog { status: string; changedAt: string; source: string; note: string | null; }
interface MeAttendance {
  record: { clockInAt: string | null; clockOutAt: string | null } | null;
  latestStatus: StatusLog | null;
  // 고객사작업/미팅 중일 때만 채워진다 — 위치이탈 자동감지가 "지금 근무중인 고객사"를 알아내는 데 쓴다.
  latestEffort: { clientName: string } | null;
}
interface WeeklySummary { from: string; to: string; totalMinutes: number; days: number; }

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ISO 시각을 한국시간 "HH:MM"으로 변환 — 야간작업 등록 제안(lateClockOutSuggestion) 미리채움용. */
function hhmmKST(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
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

/** 상태 note 안 자유서술 고객사명과 등록된 고객사 목록을 느슨하게(부분일치, 양방향) 매칭한다 —
 * 백엔드가 위치대조에 쓰는 매칭 방식과 같은 원칙(attendance.routes.ts LOCATION_CHECK_STATUSES 참고). */
function findClientCoords(
  clientLocations: { name: string; latitude: number; longitude: number }[],
  name: string | null | undefined
): { latitude: number; longitude: number } | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return clientLocations.find((c) => c.name.includes(trimmed) || trimmed.includes(c.name)) ?? null;
}

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

export default function EmployeeHome() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [hqLocation, setHqLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showHqReturnPrompt, setShowHqReturnPrompt] = useState(false);
  const [showAltDayOffPrompt, setShowAltDayOffPrompt] = useState(false);
  const [lateClockOutSuggestion, setLateClockOutSuggestion] = useState<{ overMinutes: number; suggestedStart: string; suggestedEnd: string } | null>(null);
  const [clientLocations, setClientLocations] = useState<{ name: string; latitude: number; longitude: number }[]>([]);
  const [arrivedClient, setArrivedClient] = useState<string | null>(null);
  // 고객사미팅/고객사작업 등록 시 검색·선택하는 전체 고객사 목록(좌표 유무 무관) — 2026-09-02 추가.
  const [clientOptions, setClientOptions] = useState<{ id: string; name: string }[]>([]);
  // 2026-09-04: 목록을 못 불러온 건지(네트워크 오류) 아니면 진짜로 등록된 고객사가 없는 건지
  // 화면에서 구분이 안 돼서 "목록이 안 보여요" 문의가 들어옴 — 원인 파악용으로 구분해서 보여준다.
  const [clientOptionsError, setClientOptionsError] = useState(false);
  const [clientQuery, setClientQuery] = useState('');
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const [addingClientBusy, setAddingClientBusy] = useState(false);
  const hqPromptSnoozedUntilRef = useRef(0);
  const clientPromptSnoozedUntilRef = useRef(0);
  // 마지막 근무위치(본사/고객사) 이탈 감지용 — 계속 벗어나 있는 시간을 재기 위한 시작시각과,
  // "아직 근무중이에요"로 오탐 처리했을 때 잠시 다시 안 물어보게 하는 스누즈 시각.
  const departureAwaySinceRef = useRef<{ anchorKey: string; since: number } | null>(null);
  const departureSnoozedUntilRef = useRef(0);
  const [departureSuggestion, setDepartureSuggestion] = useState<{ correctionRequestId: string; estimatedAt: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [myStatus, setMyStatus] = useState<MeAttendance | null>(null);
  const currentStatus = myStatus?.latestStatus;
  const clockedOut = Boolean(myStatus?.record?.clockOutAt);
  // 관리자 권한 계정은 퇴근 후에도 테스트할 수 있게 상태변경 잠금에서 예외로 둔다.
  const isAdminAccount = Boolean(me?.roles?.some((r) => ['SYSTEM_ADMIN', 'HR_ADMIN'].includes(r)));
  // 부서별/개인별 상태 아이콘·입력폼 커스터마이징(DEPARTMENT_STATUS_OVERRIDES, USER_STATUS_OVERRIDES
  // 참고) — 개인별 설정이 있으면 그게 우선이고, 없으면 부서 설정을 쓴다. 둘 다 없으면 undefined이고,
  // 그 경우 아래 로직은 전부 기존 동작(9개 전부 + 세부폼) 그대로다.
  const deptStatusOverride = (me?.name ? USER_STATUS_OVERRIDES[me.name] : undefined)
    ?? (me?.department ? DEPARTMENT_STATUS_OVERRIDES[me.department] : undefined);
  const visibleStatusOrder = deptStatusOverride
    ? STATUS_ORDER.filter((code) => deptStatusOverride.visibleStatuses.includes(code))
    : STATUS_ORDER;
  const [weekly, setWeekly] = useState<WeeklySummary | null>(null);
  const [weather, setWeather] = useState<WeatherInfo>({ condition: null, tempC: null });
  // 방금(오탭 포함) 등록한 상태를 되돌릴 수 있는 정보 — 9개 아이콘 즉시등록 직후에만 채워진다.
  const [undoInfo, setUndoInfo] = useState<{
    statusLogId: string;
    effortLogId?: string;
    nightWorkId?: string;
    businessTripLogId?: string;
    label: string;
    expiresAt: number;
  } | null>(null);

  // 되돌리기 유효시간(10분)이 지나면 알림을 자동으로 치운다.
  useEffect(() => {
    if (!undoInfo) return;
    const remain = undoInfo.expiresAt - Date.now();
    if (remain <= 0) { setUndoInfo(null); return; }
    const timer = setTimeout(() => setUndoInfo(null), remain);
    return () => clearTimeout(timer);
  }, [undoInfo]);

  // 고객사미팅/고객사작업/야간작업 공용 상세입력 폼 상태
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workStart, setWorkStart] = useState(nowHHMM());
  const [workEnd, setWorkEnd] = useState('');
  const [workType, setWorkType] = useState(WORK_TYPE_OPTIONS[0]);
  const [workDetail, setWorkDetail] = useState('');
  const [workReason, setWorkReason] = useState(''); // 육하원칙 중 "왜(목적/사유)"
  // 작업위치(원격/현장, 필수) · 작업인원(추가 투입 인원, 선택) · 진행률/차수(선택)
  const [siteType, setSiteType] = useState<'ONSITE' | 'REMOTE'>('ONSITE');
  const [personnel, setPersonnel] = useState('');
  const [progressStage, setProgressStage] = useState('');
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
  // 알림을 아직 안 켠 직원에게 먼저 물어봐서 옵트인율을 올리기 위한 배너(2026-09-03 추가) —
  // 화면 아래 작은 버튼만으로는 존재조차 모르는 직원이 많았을 것으로 보여 추가.
  const [showPushPrompt, setShowPushPrompt] = useState(false);
  // 2026-09-04: 아이폰 사파리는 홈 화면에 추가한 앱(standalone)에서만 알림을 지원한다(iOS 정책).
  // 이 경우 알림 켜기 버튼을 눌러도 항상 실패하므로, 미리 감지해서 버튼 문구/동작을 안내로 바꾼다.
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [pendingCorrections, setPendingCorrections] = useState<PendingCorrectionRow[]>([]);
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  // 아직 신청조차 안 했거나, 신청했다가 반려된 지난 근무일이 하나라도 있으면 상태 아이콘을 잠근다.
  // 승인 대기중(PENDING)인 것은 이미 본인이 조치했으므로 잠그지 않는다.
  const mustResolvePastCorrection = pendingCorrections.some((r) => !r.latestRequest || r.latestRequest.status === 'REJECTED');

  function refreshMyStatus() {
    apiFetch<MeAttendance>('/attendance/me').then(setMyStatus).catch(() => {});
    apiFetch<WeeklySummary>('/attendance/me/weekly').then(setWeekly).catch(() => {});
    apiFetch<PendingCorrectionRow[]>('/attendance-correction/pending').then(setPendingCorrections).catch(() => {});
  }

  useEffect(() => {
    const needsInstall = isIOSDevice() && !isStandalonePWA();
    setIosNeedsInstall(needsInstall);
    isPushSubscribed().then((subscribed) => {
      setPushSubscribed(subscribed);
      // 이미 켜져 있거나, 브라우저 알림권한을 이미 허용/거부해서 결론이 난 경우엔 배너를 안 띄운다
      // (거부한 사람에게 다시 물어봐도 브라우저가 자동으로 막아서 의미가 없다). 이번 방문(세션)에서
      // 이미 "나중에요"를 눌렀으면 같은 세션 안에서는 다시 안 띄운다. 아이폰인데 아직 홈 화면
      // 앱으로 안 열었으면(needsInstall) 어차피 알림을 켤 수 없으니, "네, 알림 받을게요" 배너
      // 대신 설치 안내 배너를 보여준다(아래 JSX에서 분기).
      if (subscribed || typeof window === 'undefined') return;
      if (!needsInstall && (!('Notification' in window) || Notification.permission !== 'default')) return;
      try {
        if (sessionStorage.getItem('pushPromptDismissed')) return;
      } catch {
        // sessionStorage 접근 불가(사파리 프라이빗 모드 등)해도 배너는 그냥 보여준다.
      }
      setShowPushPrompt(true);
    }).catch(() => {});
  }, []);

  function dismissPushPrompt() {
    setShowPushPrompt(false);
    try {
      sessionStorage.setItem('pushPromptDismissed', '1');
    } catch {}
  }

  async function acceptPushPrompt() {
    setShowPushPrompt(false);
    try {
      sessionStorage.setItem('pushPromptDismissed', '1');
    } catch {}
    await togglePush();
  }

  async function togglePush() {
    setPushLoading(true);
    try {
      if (pushSubscribed) {
        await unsubscribeFromPush();
        setPushSubscribed(false);
        setMessage('출퇴근 알림을 껐습니다.');
        setMessageIsError(false);
      } else {
        await subscribeToPush();
        setPushSubscribed(true);
        setMessage('출퇴근 알림을 켰습니다. 오전 9시까지 상태 등록을 안 하셨거나, 저녁에 퇴근을 안 누르셨으면 등록하실 때까지 계속 알려드립니다.');
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
        refreshMyStatus();
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // 출퇴근 인사말에 반영할 날씨(본사 위치 기준). 백엔드가 30분 캐시하므로 프론트도 같은 주기로만
  // 다시 불러온다. API 키 미설정/조회 실패 시 condition:null이 오고, 그때는 인사말에서 그냥 생략된다.
  useEffect(() => {
    function loadWeather() {
      apiFetch<WeatherInfo>('/weather/current').then(setWeather).catch(() => {});
    }
    loadWeather();
    const id = setInterval(loadWeather, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

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
    apiFetch<{ id: string; name: string }[]>('/attendance/clients')
      .then(setClientOptions)
      .catch(() => setClientOptionsError(true));
  }, []);

  // 이 상태들은 이미 "고객사에 있다"고 등록된 상태라, 고객사 도착 제안이나 이탈 감지를 또 띄울
  // 필요가 없다(대체휴무/휴가도 근무중이 아니니 당연히 제외).
  const CLIENT_PROMPT_SKIP_STATUSES = new Set(['CLIENT_WORK', 'CLIENT_MEETING', 'RESIDENT_ONSITE', 'ON_LEAVE', 'ALT_DAY_OFF']);

  // 5분마다 위치를 확인해서 (1) 본사/고객사 근처인데 아직 그 상태가 아니면 등록 제안을, (2) 반대로
  // 마지막 근무위치를 30분 이상 벗어났으면 퇴근 제안을 띄운다. 위치는 이 순간에만 잠깐 확인하고
  // 서버로 좌표 자체를 보내지 않으며(브라우저 안에서만 거리 계산), 강제로 상태를 바꾸지 않고
  // 직원이 직접 확인 버튼을 눌러야 확정된다(2026-09-04: 이전엔 고객사 감지가 "이동중" 상태일 때만
  // 동작했는데, 상태와 무관하게 항상 동작하도록 넓혔다 + 퇴근 이탈감지 신설).
  useEffect(() => {
    if (!me?.locationConsentGiven) return;
    const latestEffortClientName = myStatus?.latestEffort?.clientName ?? null;
    const assignedClient = me.assignedClient;

    function resolveWorkAnchor(): { lat: number; lng: number } | null {
      if (!currentStatus) return null;
      if (currentStatus.status === 'HQ_WORKING') return hqLocation;
      if (currentStatus.status === 'RESIDENT_ONSITE') {
        const c = findClientCoords(clientLocations, assignedClient);
        return c ? { lat: c.latitude, lng: c.longitude } : null;
      }
      if (currentStatus.status === 'CLIENT_WORK' || currentStatus.status === 'CLIENT_MEETING') {
        const c = findClientCoords(clientLocations, latestEffortClientName);
        return c ? { lat: c.latitude, lng: c.longitude } : null;
      }
      return null; // 재택/이동중/야간작업/출장은 고정된 근무위치가 없어 이탈감지 대상이 아니다.
    }

    const checkArrival = async () => {
      if (clockedOut) return;

      const wantsClientCheck = !(currentStatus && CLIENT_PROMPT_SKIP_STATUSES.has(currentStatus.status))
        && clientLocations.length > 0
        && Date.now() >= clientPromptSnoozedUntilRef.current;
      const wantsHqCheck = Boolean(hqLocation) && currentStatus?.status !== 'HQ_WORKING' && Date.now() >= hqPromptSnoozedUntilRef.current;
      const anchor = !departureSuggestion && Date.now() >= departureSnoozedUntilRef.current ? resolveWorkAnchor() : null;
      if (!anchor) departureAwaySinceRef.current = null;

      // 위치 확인이 여러 번 필요하더라도(고객사 도착/본사 복귀/이탈 감지) GPS는 이 틱에서 딱 한 번만
      // 읽어서 재사용한다 — 매번 새로 읽으면 배터리도 더 쓰고 권한 프롬프트도 잦아진다.
      if (!wantsClientCheck && !wantsHqCheck && !anchor) return;
      const loc = await getCurrentLocation();
      if (!loc) return;

      // 고객사 도착 감지 — 이미 고객사에 있다고 등록된 상태/휴무가 아니면 상태와 무관하게 항상 확인한다.
      if (wantsClientCheck) {
        const nearby = clientLocations.find((c) => distanceMeters(loc.lat, loc.lng, c.latitude, c.longitude) <= 300);
        if (nearby) { setArrivedClient(nearby.name); return; }
      }

      // 본사 복귀 감지
      if (wantsHqCheck && hqLocation) {
        const dist = distanceMeters(loc.lat, loc.lng, hqLocation.lat, hqLocation.lng);
        if (dist <= 300) { setShowHqReturnPrompt(true); return; }
      }

      // 마지막 근무위치 이탈 감지 — 본사/고객사에 있어야 할 상태인데 30분 이상 계속 벗어나 있으면
      // 퇴근시각 후보를 만들어 확인을 요청한다(본인이 확정하지 않으면 관리자 승인함으로 넘어간다).
      if (anchor) {
        const dist = distanceMeters(loc.lat, loc.lng, anchor.lat, anchor.lng);
        const anchorKey = `${currentStatus?.status}:${currentStatus?.changedAt}`;
        if (dist > 300) {
          if (!departureAwaySinceRef.current || departureAwaySinceRef.current.anchorKey !== anchorKey) {
            departureAwaySinceRef.current = { anchorKey, since: Date.now() };
          } else if (Date.now() - departureAwaySinceRef.current.since >= DEPARTURE_AWAY_THRESHOLD_MS) {
            const estimatedAt = new Date(departureAwaySinceRef.current.since);
            try {
              const res = await apiFetch<{ correctionRequestId: string; proposedClockOutAt: string }>(
                '/attendance/departure-suggest',
                { method: 'POST', body: JSON.stringify({ estimatedClockOutAt: estimatedAt.toISOString() }) }
              );
              setDepartureSuggestion({ correctionRequestId: res.correctionRequestId, estimatedAt: res.proposedClockOutAt });
            } catch {
              // 실패해도 조용히 넘어간다 — 다음 5분 주기에 다시 시도된다.
            }
          }
        } else {
          departureAwaySinceRef.current = null;
        }
      }
    };
    const interval = setInterval(checkArrival, 5 * 60 * 1000);
    const timeout = setTimeout(checkArrival, 30 * 1000); // 페이지 켠 직후에도 한 번 확인
    return () => { clearInterval(interval); clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hqLocation, clientLocations, me?.locationConsentGiven, me?.assignedClient, currentStatus?.status, currentStatus?.changedAt, myStatus?.latestEffort?.clientName, clockedOut, departureSuggestion]);

  async function run(action: () => Promise<unknown>, successMsg: string, onSuccess?: (data: unknown) => void) {
    setMessage(null);
    setMessageIsError(false);
    try {
      const data = await action();
      setMessage(successMsg);
      refreshMyStatus();
      onSuccess?.(data);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
      setMessageIsError(true);
    }
  }

  /** 방금(오탭 포함) 등록한 상태를 취소한다 — /status 응답으로 받은 id들을 그대로 되돌려보낸다. */
  async function undoLastStatusChange() {
    if (!undoInfo) return;
    const info = undoInfo;
    setUndoInfo(null);
    // 방금 취소한 상태의 세부입력폼이 화면에 열려있으면(오탭 직후 자동으로 열림) 같이 닫아준다.
    setDetailStatus(null);
    run(
      () =>
        apiFetch('/attendance/status/undo', {
          method: 'POST',
          body: JSON.stringify({
            statusLogId: info.statusLogId,
            effortLogId: info.effortLogId,
            nightWorkId: info.nightWorkId,
            businessTripLogId: info.businessTripLogId,
          }),
        }),
      `'${info.label}' 등록을 취소하고 이전 상태로 되돌렸어요. 😊`
    );
  }

  /** 마지막 근무위치를 벗어난 지 30분이 지났을 때, 본인이 직접 확인하고 그 시각으로 퇴근을 확정한다. */
  async function confirmDepartureSuggestion() {
    if (!departureSuggestion) return;
    const info = departureSuggestion;
    setDepartureSuggestion(null);
    departureAwaySinceRef.current = null;
    run(
      () => apiFetch('/attendance/departure-suggest/confirm', { method: 'POST', body: JSON.stringify({ correctionRequestId: info.correctionRequestId }) }),
      `${fmtClock(info.estimatedAt)}에 퇴근하신 걸로 확정했어요. ${clockOutGreeting(weather)}`
    );
  }

  /** "아직 근무중이에요" — 오탐이었다고 알려주면 대기중이던 제안을 취소한다. */
  function dismissDepartureSuggestion() {
    if (!departureSuggestion) return;
    const info = departureSuggestion;
    setDepartureSuggestion(null);
    departureAwaySinceRef.current = null;
    departureSnoozedUntilRef.current = Date.now() + 30 * 60 * 1000; // 30분 동안 다시 안 물어봄
    apiFetch('/attendance/departure-suggest/dismiss', { method: 'POST', body: JSON.stringify({ correctionRequestId: info.correctionRequestId }) }).catch(() => {});
  }

  // 2026-09-02: 본사 위치확인이 서버에서 막히는 경우(AWAY_FROM_HQ/LOCATION_REQUIRED_FOR_CLOCKIN) —
  // 실내(특히 대형 건물)에서는 브라우저가 GPS 대신 WiFi/IP 기반의 부정확한 첫 위치를 줄 수 있다.
  // geolocation.ts에서 enableHighAccuracy를 켜두긴 했지만, 그래도 첫 시도가 부정확할 수 있어
  // 이 두 에러코드에 한해 위치를 다시 캡처해서 자동으로 딱 한 번만 재시도한다. 재시도까지
  // 같은 이유로 실패하면(=진짜로 본사에서 먼 경우 포함) 원래 에러를 그대로 보여준다 — "위치가
  // 잡혔는데 실제로 멀면 항상 차단"이라는 정책은 그대로 유지된다(실제 불일치를 봐주지 않음).
  const LOCATION_RETRY_CODES = new Set(['AWAY_FROM_HQ', 'LOCATION_REQUIRED_FOR_CLOCKIN']);
  async function attemptWithLocationRetry<T>(
    submit: () => Promise<T>,
    refreshLocation?: () => Promise<void>
  ): Promise<T> {
    try {
      return await submit();
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      if (!refreshLocation || !code || !LOCATION_RETRY_CODES.has(code)) throw err;
      setMessage('📡 위치 정확도를 높여 다시 확인하고 있어요. 잠시만 기다려주세요...');
      setMessageIsError(false);
      await refreshLocation();
      return submit();
    }
  }

  function openDetailForm(code: string, prefilledClientName?: string) {
    setDetailStatus(code);
    const initialClientName = prefilledClientName ?? (code === 'RESIDENT_ONSITE' ? (me?.assignedClient ?? '') : '');
    setClientName(initialClientName);
    // 고객사미팅/고객사작업의 검색창 콤보박스도 같은 초기값으로 맞춰준다(예: GPS 도착감지로
    // 이미 고객사명이 채워진 경우, 검색창에도 바로 그 이름이 보이게).
    setClientQuery(initialClientName);
    setClientPickerOpen(false);
    setProjectName('');
    setWorkStart(nowHHMM());
    setWorkEnd('');
    setWorkType(code === 'HQ_WORKING' ? HQ_WORK_TYPE_OPTIONS[0] : code === 'CLIENT_MEETING' ? MEETING_PURPOSE_OPTIONS[0] : WORK_TYPE_OPTIONS[0]);
    setWorkDetail('');
    setWorkReason('');
    setSiteType('ONSITE');
    setPersonnel('');
    setProgressStage('');
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

  /** 퇴근 시 "18시 이후분은 야간작업으로 등록하시겠어요?" 제안을 수락하면, 야간작업 상세폼을
   * 열고 시작/완료 시각을 제안값으로 미리 채워준다(등록은 본인이 내용 확인 후 직접 확정). */
  function acceptLateClockOutSuggestion() {
    if (!lateClockOutSuggestion) return;
    const suggestion = lateClockOutSuggestion;
    openDetailForm('NIGHT_WORK');
    setWorkStart(hhmmKST(suggestion.suggestedStart));
    setWorkEnd(hhmmKST(suggestion.suggestedEnd));
    setLateClockOutSuggestion(null);
  }

  async function changeStatus(code: string, prefilledClientName?: string) {
    const alreadyInThisStatus = currentStatus?.status === code;
    // 새 상태를 등록한다는 건 본인이 여전히 활동중이라는 뜻이므로, 혹시 떠 있던 "퇴근 이탈감지"
    // 제안이 있다면 더 이상 맞지 않는 추정이니 같이 정리한다(오탐으로 조용히 취소).
    if (!alreadyInThisStatus && departureSuggestion) dismissDepartureSuggestion();
    // 직전 상태의 내용을 아직 안 채운 채로 다른 상태로 넘어가는 경우, 막지는 않되(사용자가 화면에
    // 갇히면 안 되므로) "직전 것도 잊지 마세요" 정도의 부드러운 리마인더만 붙여준다. 다만 직전
    // 상태가 부서 설정상 애초에 세부폼이 없는 상태(noFormStatuses)였다면 채울 내용 자체가 없으니
    // 리마인더를 붙이지 않는다.
    const prevWasNoForm = Boolean(currentStatus && deptStatusOverride?.noFormStatuses.includes(currentStatus.status));
    const pendingPrev = currentStatus && !currentStatus.note && !alreadyInThisStatus && !prevWasNoForm ? currentStatus : null;

    // 즉시등록 대상은 처음 누르면 상세폼 없이 바로 등록해서 상황판에 즉시 반영한다.
    // ("세부내용은 나중에 작성" — 시작하는 시점엔 아직 쓸 내용이 없는 게 당연하므로.)
    if (QUICK_REGISTER_STATUSES.has(code) && !alreadyInThisStatus) {
      const body: Record<string, unknown> = { status: code };
      if (['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'REMOTE'].includes(code)) {
        body.effort = { clientName: prefilledClientName || undefined, startTime: nowHHMM() };
      }
      // 고객사미팅/고객사작업/야간작업은 작업위치(원격/현장)가 필수라, 우선 등록되는 이 시점에는
      // 안전한 기본값(현장)으로 채워두고, 실제 값은 아래 열리는 상세폼에서 다시 골라 등록하게 한다
      // (상세폼 제출 시 최신 상태 로그로 다시 남으므로 그때의 값이 최종적으로 반영된다).
      if (SITE_DETAIL_STATUSES.has(code)) {
        body.siteType = 'ONSITE';
      }
      if (code === 'BUSINESS_TRIP') {
        body.businessTrip = { destination: '(추후 입력)', purpose: '(추후 입력)', startAt: new Date().toISOString() };
      }
      // 본사근무는 실제로 본사에 있는지 위치로 확인한다 — 아니면 서버에서 막고 고객사미팅/작업으로
      // 유도한다. 위치 확보 실패 사유(locationStatus)까지 같이 보내야 서버가 "오늘 첫 실패는
      // 봐준다" 판단을 할 수 있다(고객사작업/미팅과 동일한 방식).
      // 2026-09 GPS 정확도 개선: 위치 캡처 시 오차범위(accuracy)를 같이 기록해뒀다가, 성공
      // 메시지에 "정확도가 낮았다"는 안내를 덧붙인다(geolocation.ts가 내부적으로 이미 한 번
      // 재시도했지만, 그래도 여전히 부정확할 수 있어 본인이 인지하고 있는 게 좋다).
      const hqQuickLocationMeta: { accuracy: number | null } = { accuracy: null };
      const refreshHqQuickLocation = async () => {
        const { status: locStatus, coords, accuracyMeters } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
        body.locationStatus = locStatus;
        hqQuickLocationMeta.accuracy = accuracyMeters;
        if (coords) {
          body.location = coords;
          // 카카오맵 역지오코딩 — GPS 오차가 커도(예: 신한이노플렉스 사무실 835m 오차 사례) 주소가
          // 본사 건물명/도로명과 일치하면 서버에서 통과시켜줄 수 있게, 변환된 주소도 같이 보낸다.
          body.locationAddress = (await reverseGeocode(coords.lat, coords.lng)) ?? undefined;
        } else {
          delete body.location;
          delete body.locationAddress;
        }
      };
      if (code === 'HQ_WORKING') {
        await refreshHqQuickLocation();
      }
      // 부서 설정(DEPARTMENT_STATUS_OVERRIDES)에서 이 상태를 "세부폼 없이 등록만"으로 지정했으면,
      // 등록 즉시 끝난다 — 아래 세부입력폼을 아예 열지 않고, 안내 문구도 "입력해주세요"를 뺀다.
      const skipDetailForm = deptStatusOverride?.noFormStatuses.includes(code) ?? false;
      const accuracyWarningSuffix = isLowAccuracy(hqQuickLocationMeta.accuracy) ? ` (${accuracyWarningLabel(hqQuickLocationMeta.accuracy)})` : '';
      run(
        () =>
          attemptWithLocationRetry(
            () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
            code === 'HQ_WORKING' ? refreshHqQuickLocation : undefined
          ),
        pendingPrev
          ? `⚠️ 상태가 '${STATUS_META[code].label}'(으)로 변경됐지만, 직전 '${STATUS_META[pendingPrev.status]?.label ?? pendingPrev.status}' 내용을 아직 안 채우셨어요! 잊지 말고 채워주세요.`
          : skipDetailForm
            ? `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊${accuracyWarningSuffix}`
            : `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊 아래에서 세부내용을 입력해주세요.${accuracyWarningSuffix}`,
        (data) => {
          // 아이콘을 잘못 눌렀을 때 흔적 없이 되돌릴 수 있게, 방금 만들어진 기록들의 id를 잠깐 기억해둔다.
          const res = data as {
            statusLog?: { id: string };
            effortLog?: { id: string } | null;
            nightWork?: { session?: { id: string } } | null;
            businessTripLog?: { id: string } | null;
          } | null;
          if (res?.statusLog?.id) {
            setUndoInfo({
              statusLogId: res.statusLog.id,
              effortLogId: res.effortLog?.id,
              nightWorkId: res.nightWork?.session?.id,
              businessTripLogId: res.businessTripLog?.id,
              label: STATUS_META[code].label,
              expiresAt: Date.now() + UNDO_WINDOW_MS,
            });
          }
        }
      );
      // 상태변경과 동시에 세부내용 입력폼도 바로 아래에 띄운다(두 번 누를 필요 없게) — 다만
      // 세부폼이 필요없는 부서·상태 조합이면 이 단계에서 그냥 끝낸다.
      if (!skipDetailForm) {
        openDetailForm(code, prefilledClientName);
      }
      return;
    }

    if (DETAIL_FORM_STATUSES.has(code)) {
      // 이미 같은 상태인 채로 아이콘을 다시 눌러 세부폼을 열려는 경우도, 세부폼이 필요없는
      // 부서·상태 조합이면 열 내용이 없으니 그냥 둔다.
      if (deptStatusOverride?.noFormStatuses.includes(code)) return;
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
    // 세부내용을 채워 정식 제출하면 새 상태기록이 생겨 방금 즉시등록된 기록은 더 이상 "현재
    // 상태"가 아니게 된다(되돌리기 대상에서 자동으로 제외됨) — 알림도 같이 치운다.
    setUndoInfo(null);

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

    // 간소화된 폼(본사근무/고객사미팅/고객사작업)의 최소 입력 조건 — 버튼 disabled와 동일한 조건을
    // 함수 안에서도 한 번 더 지킨다(다른 경로로 호출되더라도 항상 지켜지도록).
    const minDetailLen = code === 'HQ_WORKING' ? 15 : 10;
    if (workDetail.trim().length < minDetailLen) return;
    // 본사근무는 관련 프로젝트/고객사 자유서술이 필수, 고객사미팅/고객사작업은 등록된 고객사
    // 목록에서 고른 이름이 필수다(빈칸으로 저장되면 리포트에서 통째로 누락됨 — 2026-09-02).
    if ((code === 'HQ_WORKING' || LOCATION_CHECK_STATUSES.has(code)) && !clientName.trim()) return;
    if (!SIMPLIFIED_EFFORT_STATUSES.has(code) && !workReason.trim()) return;
    // 작업위치(원격/현장, 필수) · 작업인원(선택) · 진행률/차수(선택, 야간작업만) — 야간작업/고객사미팅/고객사작업만 해당.
    if (SITE_DETAIL_STATUSES.has(code) && !siteType) return;
    const siteDetailSuffix = SITE_DETAIL_STATUSES.has(code)
      ? ` | 작업위치: ${siteType === 'ONSITE' ? '현장' : '원격'}${personnel ? ` | 작업인원: ${personnel}` : ''}`
      : '';
    const reasonSuffix = workReason.trim() ? ` | 목적: ${workReason}` : '';
    const note = (code === 'HQ_WORKING'
      ? `유형: ${workType} | 관련 프로젝트/고객사: ${clientName || '-'} | 수행업무: ${workDetail}`
      : code === 'CLIENT_MEETING'
        ? `미팅목적: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 미팅주제: ${workDetail}${reasonSuffix}`
        : `유형: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 내용: ${workDetail}${reasonSuffix}`) + siteDetailSuffix;
    const body: Record<string, unknown> = { status: code, note };
    if (SITE_DETAIL_STATUSES.has(code)) {
      body.siteType = siteType;
    }
    if (DETAIL_FORM_STATUSES.has(code)) {
      body.effort = {
        clientName,
        projectName,
        workType,
        startTime: workStart,
        endTime: workEnd || undefined,
        description: workReason.trim() ? `${workDetail} (목적: ${workReason})` : workDetail,
        ...(SITE_DETAIL_STATUSES.has(code) ? { personnel: personnel || undefined } : {}),
      };
    }
    // 고객사미팅/고객사작업은 등록 순간 위치를 확인해서 등록된 고객사 위치와 대조한다(동의한 경우에만).
    // 위치 확보 실패 사유(locationStatus)까지 같이 보내야 서버가 "오늘 첫 실패는 봐준다" 판단을 할 수 있다.
    const needsLocationCheck = LOCATION_CHECK_STATUSES.has(code) || code === 'HQ_WORKING';
    // 본사근무도 고객사작업/미팅과 동일하게 위치 확보 실패 사유까지 같이 보낸다("오늘 첫 실패는 봐준다" 판단용).
    const detailFormLocationMeta: { accuracy: number | null } = { accuracy: null };
    const refreshDetailFormLocation = async () => {
      const { status: locStatus, coords, accuracyMeters } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
      body.locationStatus = locStatus;
      detailFormLocationMeta.accuracy = accuracyMeters;
      if (coords) {
        body.location = coords;
        // 본사근무만 역지오코딩 주소를 같이 보낸다 — 고객사미팅/작업은 등록된 고객사 좌표와
        // 직접 대조하므로 주소 매칭이 필요 없다(불필요한 카카오맵 호출도 줄인다).
        body.locationAddress = code === 'HQ_WORKING' ? (await reverseGeocode(coords.lat, coords.lng)) ?? undefined : undefined;
      } else {
        delete body.location;
        delete body.locationAddress;
      }
    };
    if (needsLocationCheck) {
      await refreshDetailFormLocation();
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
      () =>
        attemptWithLocationRetry(
          () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
          needsLocationCheck ? refreshDetailFormLocation : undefined
        ),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊${
        isLowAccuracy(detailFormLocationMeta.accuracy) ? ` (${accuracyWarningLabel(detailFormLocationMeta.accuracy)})` : ''
      }`
    );
    setDetailStatus(null);
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  // 고객사미팅/고객사작업 검색창에 입력한 글자로 등록된 고객사 목록을 걸러준다(2026-09-02).
  // 2026-09-04: 검색어가 없을 때 20개로 잘라서 보여주던 게 "고객사 목록이 일부만 나온다"는
  // 문제였다 — 목록 영역이 이미 스크롤(max-height 220px, overflow-y auto) 처리돼 있어서 자를
  // 이유가 없었다. 이제 전체를 보여주고, 목록이 너무 길면 검색으로 좁히면 된다.
  const filteredClientOptions = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return clientOptions;
    return clientOptions.filter((c) => c.name.toLowerCase().includes(q));
  }, [clientOptions, clientQuery]);
  // 입력한 글자가 등록된 고객사명과 완전히 같으면(대소문자 무관) "새로 등록" 버튼을 안 보여준다 —
  // 이미 있는 고객사를 실수로 중복 등록하는 걸 막기 위함.
  const exactClientMatch = useMemo(
    () => clientOptions.some((c) => c.name.toLowerCase() === clientQuery.trim().toLowerCase()),
    [clientOptions, clientQuery]
  );

  /** 목록에 없는 새 고객사를 그 자리에서 등록하고 바로 선택 상태로 만든다. */
  async function addNewClientAndSelect() {
    const name = clientQuery.trim();
    if (!name || addingClientBusy) return;
    setAddingClientBusy(true);
    try {
      const created = await apiFetch<{ id: string; name: string }>('/attendance/clients', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setClientOptions((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created].sort((a, b) => a.name.localeCompare(b.name))));
      setClientName(created.name);
      setClientQuery(created.name);
      setClientPickerOpen(false);
    } catch {
      setMessage('고객사 등록에 실패했습니다. 다시 시도해주세요.');
      setMessageIsError(true);
    } finally {
      setAddingClientBusy(false);
    }
  }

  const weeklyPct = useMemo(() => {
    if (!weekly) return 0;
    return Math.min(100, Math.round((weekly.totalMinutes / WEEKLY_LIMIT_MINUTES) * 100));
  }, [weekly]);
  const weeklyOver = weekly ? weekly.totalMinutes > WEEKLY_LIMIT_MINUTES : false;

  // TSB-Ver2.1: 사용자 화면을 관리자 화면과 통일된 다크 톤으로 바꾸면서, 페이지 바깥(뷰포트
  // 좌우 여백)까지 어둡게 보이도록 body에도 클래스를 붙인다(다른 화면엔 영향 없음 — 이 페이지가
  // 언마운트되면 바로 제거).
  useEffect(() => {
    document.body.classList.add('tsb-dark-body');
    return () => document.body.classList.remove('tsb-dark-body');
  }, []);

  if (!me) return <div className="page tsb-dark" style={{ minHeight: '100vh' }}>불러오는 중...</div>;

  return (
    <div className="employee-shell tsb-dark">
      <Head>
        <title>기술부 현황 등록</title>
      </Head>

      {(!me.privacyConsentGiven || !me.locationConsentGiven) && (
        <MandatoryConsentGate
          needsPrivacy={!me.privacyConsentGiven}
          needsLocation={!me.locationConsentGiven}
          onComplete={() => setMe((prev) => (prev ? { ...prev, privacyConsentGiven: true, locationConsentGiven: true } : prev))}
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
        <div className="hero-greeting">{me.name}님, {heroGreeting(weather)}! 👋</div>
        {currentStatus ? (
          <div className="hero-status">
            <span className="hero-status-icon">{clockedOut ? '🏁' : (STATUS_META[currentStatus.status]?.icon ?? '❔')}</span>
            <div>
              <div className="hero-status-label">
                {clockedOut ? '지금 상태: 퇴근완료' : `지금 상태: ${STATUS_META[currentStatus.status]?.label ?? currentStatus.status}`}
              </div>
              <div className="hero-status-time">
                {clockedOut && myStatus?.record?.clockOutAt
                  ? `${hhmmKST(myStatus.record.clockOutAt)}에 퇴근 완료`
                  : `${timeAgoShort(currentStatus.changedAt)}에 등록됨`}
              </div>
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
              <div className="weekly-gauge-fill" style={{ width: `${weeklyPct}%`, background: weeklyOver ? '#e03131' : '#4c8dff' }} />
            </div>
            <div className="weekly-gauge-sub">
              {weeklyOver ? '⚠ 주 52시간을 넘었어요, 컨디션 챙기세요' : `주 52시간 중 ${weeklyPct}% — 스스로 페이스를 확인해보세요`}
            </div>
          </div>
        )}
      </div>

      <PastDayCorrectionCard rows={pendingCorrections} onSubmitted={refreshMyStatus} />

      {showPushPrompt && iosNeedsInstall && (
        // 2026-09-04: 아이폰 사파리는 홈 화면에 추가한 앱에서만 알림이 되므로(애플 정책), 여기서는
        // 알림을 "켜는" 버튼 대신 설치 방법만 안내한다 — 버튼을 눌러도 실패할 게 뻔한데 누르게
        // 하는 건 의미가 없다.
        <div className="card col-full notice-tint-blue">
          🍎 아이폰에서 출근/퇴근 알림을 받으시려면, 먼저 하단 공유 버튼(⬆️) → <strong>&quot;홈 화면에 추가&quot;</strong>로 앱을 설치하신 뒤, 그 아이콘으로 다시 열어서 알림을 켜주세요.
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={dismissPushPrompt}>
              알겠어요
            </button>
          </div>
        </div>
      )}
      {showPushPrompt && !iosNeedsInstall && (
        <div className="card col-full notice-tint-blue">
          🔔 출근/퇴근 등록을 깜빡하실 때 알려드릴까요? 오전 9시까지 출근 등록이 없거나 저녁에 퇴근을 안 누르시면, 등록하실 때까지 알림을 보내드려요.
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={{ width: 'auto', margin: 0 }} disabled={pushLoading} onClick={acceptPushPrompt}>
              {pushLoading ? '처리 중...' : '네, 알림 받을게요'}
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={dismissPushPrompt}>
              나중에요
            </button>
          </div>
        </div>
      )}

      {arrivedClient && (
        <div className="card col-full notice-tint-blue">
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
        <div className="card col-full notice-tint-blue">
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

      {lateClockOutSuggestion && (
        <div className="card col-full notice-tint-orange">
          🌙 오늘 저녁 근무는 정규 근무시간(18시)까지만 인정되고, 그 이후 <strong>{hoursLabel(lateClockOutSuggestion.overMinutes)}</strong>은 근무시간에 반영되지 않았어요.
          야간작업으로 별도 등록하시겠어요?
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={{ width: 'auto', margin: 0 }} onClick={acceptLateClockOutSuggestion}>
              네, 야간작업으로 등록할게요
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setLateClockOutSuggestion(null)}>
              나중에요
            </button>
          </div>
        </div>
      )}

      {showHqReturnPrompt && (
        <div className="card col-full notice-tint-blue">
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

      {departureSuggestion && (
        <div className="card col-full notice-tint-orange">
          🚪 마지막 근무위치를 벗어난 지 30분이 지났어요. <strong>{fmtClock(departureSuggestion.estimatedAt)}</strong>에 퇴근하신 걸로 확정할까요?
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={{ width: 'auto', margin: 0 }} onClick={confirmDepartureSuggestion}>
              네, 확정할게요
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={dismissDepartureSuggestion}>
              아니요, 아직 근무중이에요
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className={`card col-full ${message.startsWith('⚠️') || messageIsError ? 'msg-warn' : 'msg-success'}`}>
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
              onClick={async () => {
                setMessage(null);
                setMessageIsError(false);
                try {
                  const clockInBody: Record<string, unknown> = {};
                  const clockInLocationMeta: { accuracy: number | null } = { accuracy: null };
                  const refreshClockInLocation = async () => {
                    const { status: locStatus, coords, accuracyMeters } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
                    clockInBody.locationStatus = locStatus;
                    clockInLocationMeta.accuracy = accuracyMeters;
                    if (coords) {
                      clockInBody.location = coords;
                      clockInBody.locationAddress = (await reverseGeocode(coords.lat, coords.lng)) ?? undefined;
                    } else {
                      delete clockInBody.location;
                      delete clockInBody.locationAddress;
                    }
                  };
                  await refreshClockInLocation();
                  const result = await attemptWithLocationRetry(
                    () => apiFetch<{ locationConfirmed?: boolean }>('/attendance/clock-in', {
                      method: 'POST',
                      body: JSON.stringify(clockInBody),
                    }),
                    refreshClockInLocation
                  );
                  const accuracySuffix = isLowAccuracy(clockInLocationMeta.accuracy) ? ` (${accuracyWarningLabel(clockInLocationMeta.accuracy)})` : '';
                  setMessage((result.locationConfirmed ? '✅ 위치 확인 완료 — 정상출근 처리되었습니다.' : '출근 처리되었습니다.') + accuracySuffix);
                  refreshMyStatus();
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
                  setMessageIsError(true);
                }
              }}
            >
              {myStatus?.record?.clockInAt ? `✓ 출근 완료 · ${fmtClock(myStatus.record.clockInAt)}` : '출근'}
            </button>
            <button
              className={myStatus?.record?.clockOutAt ? 'done' : 'secondary'}
              disabled={!myStatus?.record?.clockInAt || Boolean(myStatus?.record?.clockOutAt)}
              onClick={() => setShowClockOutConfirm(true)}
            >
              {myStatus?.record?.clockOutAt ? `✓ 퇴근 완료 · ${fmtClock(myStatus.record.clockOutAt)}` : '퇴근'}
            </button>
            {showClockOutConfirm && myStatus?.record?.clockInAt && (
              <ClockOutConfirmModal
                clockInAt={myStatus.record.clockInAt}
                locationConsentGiven={Boolean(me?.locationConsentGiven)}
                onCancel={() => setShowClockOutConfirm(false)}
                onConfirm={async ({ locationAddress, locationStatus, earlyLeaveReason }) => {
                  // 18시 이후 정규근무분 초과(야간작업 등록 제안) 여부를 응답에서 바로 확인해야 해서
                  // run()을 안 거치고 직접 호출한다(NIGHT_WORK 등록과 같은 이유).
                  setMessage(null);
                  setMessageIsError(false);
                  try {
                    const res = await apiFetch<{ lateClockOutSuggestion: { overMinutes: number; suggestedStart: string; suggestedEnd: string } | null }>(
                      '/attendance/clock-out',
                      {
                        method: 'POST',
                        body: JSON.stringify({
                          ...(locationAddress ? { locationAddress } : {}),
                          locationStatus,
                          ...(earlyLeaveReason ? { earlyLeaveReason } : {}),
                        }),
                      }
                    );
                    setMessage(`퇴근 처리되었습니다. ${clockOutGreeting(weather)}`);
                    refreshMyStatus();
                    if (res.lateClockOutSuggestion) setLateClockOutSuggestion(res.lateClockOutSuggestion);
                  } catch (err) {
                    setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
                    setMessageIsError(true);
                  }
                  setShowClockOutConfirm(false);
                }}
              />
            )}
            <div className="notice-inline-orange">
              ⚠️ 출근은 자동이에요 — 상태를 누르면 그 순간이 출근시각이 됩니다.
              <span style={{ fontWeight: 400 }}>
                {' '}"출근" 버튼은 본사 위치가 확인될 때만 처리돼요. 고객사로 바로 가는 날, 출장이나 상주근무인 날은 "출근" 버튼 대신 도착 후 상태를 눌러주세요. 하루를 마치면 꼭 "퇴근"을 눌러야 근무가 확정돼요.
              </span>
            </div>
            {!pushSubscribed && iosNeedsInstall ? (
              // 2026-09-04: 아이폰 사파리(홈 화면 앱이 아닌 상태)에서는 눌러도 항상 실패하므로,
              // 버튼 대신 이유와 방법을 바로 보여준다 — "안 된다"가 아니라 "이렇게 하면 된다"로.
              <div className="notice-inline-orange">
                🍎 아이폰에서는 하단 공유 버튼(⬆️) → <strong>&quot;홈 화면에 추가&quot;</strong>로 앱을 설치한 뒤, 그 아이콘으로 열어야 알림을 켤 수 있어요(애플 정책 — 사파리 탭에서는 지원 안 함).
              </div>
            ) : (
              <button className="secondary" disabled={pushLoading} onClick={togglePush}>
                {pushLoading ? '처리 중...' : pushSubscribed ? '🔔 출퇴근 알림 끄기' : '🔕 출퇴근 알림 켜기(출근 오전 9시·퇴근 저녁)'}
              </button>
            )}
          </div>

          <div className="card">
            <h2>지금 상태 콕! 눌러주세요. 근무기록은 여러분들에게 더 큰 혜택을 드릴 수 있어요.</h2>
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
              {visibleStatusOrder.map((code) => {
                // 퇴근(낮근무 종료) 후에도 야간작업자는 계속 상태를 등록해야 하니 예외로 둔다.
                // 지난 근무일 퇴근 미해결 건이 있으면(정정 신청 전까지) 야간작업 예외 없이 전부 잠근다 —
                // 오늘 상태를 계속 쌓아가기 전에 어제 문제부터 정리하게 하기 위함.
                const isLocked = mustResolvePastCorrection
                  ? !isAdminAccount
                  : clockedOut && code !== 'NIGHT_WORK' && !isAdminAccount;
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
            {undoInfo && (
              <div
                className="notice-inline-orange"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8, marginBottom: 0 }}
              >
                <span>↩️ 방금 '{undoInfo.label}'(으)로 등록했어요. 잘못 누르셨다면 지금 되돌릴 수 있어요(10분 이내).</span>
                <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={undoLastStatusChange}>
                  되돌리기
                </button>
              </div>
            )}
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
              <p className="hint-box">
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
              <p className="hint-box">
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
              <p className="hint-box">
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
              <p className="hint-box">
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
              <p className="hint-box">
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
                <p className="hint-box">
                  * 이미 '{STATUS_META[detailStatus].label}'(으)로 등록되어 있습니다. 작업이 마무리됐으면 여기서 내용/완료시간을 채워주세요.
                </p>
              ) : (
                <p className="hint-box">
                  * 내용을 입력하고 등록하면 바로 '{STATUS_META[detailStatus].label}' 상태로 반영됩니다. 완료시간은 몰라도(진행중이면) 비워두고 등록 가능합니다.
                </p>
              )}
              <label className="field-label">
                {detailStatus === 'HQ_WORKING' ? '고객사/관련 프로젝트 (필수)' : detailStatus === 'REMOTE' ? '지원 고객사' : LOCATION_CHECK_STATUSES.has(detailStatus) ? '고객사명 (필수 — 목록에서 선택)' : '고객사명'}
                {detailStatus === 'NIGHT_WORK' ? '(내부 작업이면 비워두세요)' : ''}
              </label>
              {LOCATION_CHECK_STATUSES.has(detailStatus) ? (
                <div className="client-combobox">
                  <input
                    value={clientQuery}
                    onChange={(e) => {
                      setClientQuery(e.target.value);
                      setClientName(''); // 목록에서 다시 고르거나 새로 등록하기 전까지는 미확정 상태로 둔다.
                      setClientPickerOpen(true);
                    }}
                    onFocus={() => setClientPickerOpen(true)}
                    onBlur={() => setTimeout(() => setClientPickerOpen(false), 150)}
                    placeholder="고객사명 검색 (예: OO상사)"
                  />
                  {/* 2026-09-04: position:absolute로 입력창 아래 띄우던 걸 일반 흐름으로 바꿨다 —
                      모바일에서 화면키보드가 뜨면 절대좌표로 겹쳐 그려지는 목록이 키보드에 가려져
                      "목록이 안 보여요" 문제가 있었다. 그냥 아래로 밀어내는 방식이 항상 보인다. */}
                  {clientPickerOpen && (
                    <div className="client-combobox-list">
                      {clientOptionsError && (
                        <div className="client-combobox-empty">⚠ 고객사 목록을 불러오지 못했습니다. 인터넷 연결을 확인하고 화면을 새로고침 해주세요.</div>
                      )}
                      {!clientOptionsError && filteredClientOptions.length === 0 && !clientQuery.trim() && (
                        <div className="client-combobox-empty">등록된 고객사가 없습니다. 아래에 이름을 입력해 새로 등록해주세요.</div>
                      )}
                      {filteredClientOptions.map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          className="client-combobox-item"
                          onMouseDown={(e) => {
                            e.preventDefault(); // onBlur보다 먼저 선택이 처리되게(안 그러면 목록이 먼저 닫혀버림).
                            setClientName(c.name);
                            setClientQuery(c.name);
                            setClientPickerOpen(false);
                          }}
                        >
                          {c.name}
                        </button>
                      ))}
                      {clientQuery.trim() && !exactClientMatch && (
                        <button
                          type="button"
                          className="client-combobox-item client-combobox-add"
                          disabled={addingClientBusy}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            addNewClientAndSelect();
                          }}
                        >
                          ➕ &ldquo;{clientQuery.trim()}&rdquo; 새 고객사로 등록
                        </button>
                      )}
                    </div>
                  )}
                  {!clientName.trim() && (
                    <p className="hint-box" style={{ marginTop: 4 }}>* 목록에서 고객사를 선택하거나, 목록에 없으면 새로 등록해주세요.</p>
                  )}
                </div>
              ) : (
                <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="예: OO상사" />
              )}

              {EFFORT_STATUSES.has(detailStatus) && detailStatus !== 'HQ_WORKING' && (
                <>
                  <label className="field-label">프로젝트명</label>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="예: 백업시스템 구축 2차" />
                </>
              )}

              <label className="field-label">{detailStatus === 'CLIENT_MEETING' ? '미팅목적' : '작업 유형'}</label>
              <select className="field-select" value={workType} onChange={(e) => setWorkType(e.target.value)}>
                {(detailStatus === 'HQ_WORKING' ? HQ_WORK_TYPE_OPTIONS : detailStatus === 'CLIENT_MEETING' ? MEETING_PURPOSE_OPTIONS : WORK_TYPE_OPTIONS).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>

              {detailStatus !== 'HQ_WORKING' && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label className="field-label">{detailStatus === 'CLIENT_MEETING' ? '미팅시작' : '작업시작'}</label>
                    <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="field-label">{detailStatus === 'CLIENT_MEETING' ? '미팅완료(선택 — 진행중이면 비워두세요)' : '작업완료(선택 — 진행중이면 비워두세요)'}</label>
                    <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} />
                  </div>
                </div>
              )}

              <label className="field-label">
                {detailStatus === 'HQ_WORKING'
                  ? `오늘 수행업무 (필수 — 언제·무엇을·어떻게 했는지 구체적으로, 최소 15자)`
                  : detailStatus === 'CLIENT_MEETING' ? '미팅주제(무엇을/어떻게 — 최소 10자)' : '작업내용(무엇을/어떻게 — 최소 10자)'}
              </label>
              <textarea
                className="detail-textarea right-col-textarea"
                rows={3}
                placeholder={detailStatus === 'HQ_WORKING' ? '예: 오전엔 A고객사 백업 정책서 신규 작성, 오후엔 사내 모니터링 대시보드 알람 규칙 정비' : detailStatus === 'CLIENT_MEETING' ? '예: 2026년도 유지보수 계약 조건 협의' : '예: 서버 3대 정기점검 후 백업 정책을 재협의함'}
                value={workDetail}
                onChange={(e) => setWorkDetail(e.target.value)}
              />
              {detailStatus === 'HQ_WORKING' && (
                <p style={{ fontSize: 12, color: '#6b7594', marginTop: -6, marginBottom: 10 }}>
                  💡 나중에 찾아보기 쉽도록, 오늘 한 일을 구체적으로 적어주세요(예: "무엇을 · 어떤 목적으로 · 어떻게" 순서로).
                </p>
              )}

              {!SIMPLIFIED_EFFORT_STATUSES.has(detailStatus) && (
                <>
                  <label className="field-label">목적/사유(왜)</label>
                  <input
                    value={workReason}
                    onChange={(e) => setWorkReason(e.target.value)}
                    placeholder="예: 정기 유지보수 계약에 따른 월간 점검"
                  />
                </>
              )}

              {SITE_DETAIL_STATUSES.has(detailStatus) && (
                <>
                  <label className="field-label">작업위치 (필수)</label>
                  <select className="field-select" value={siteType} onChange={(e) => setSiteType(e.target.value as 'ONSITE' | 'REMOTE')}>
                    <option value="ONSITE">🏬 현장(고객사 등)</option>
                    <option value="REMOTE">🏠 원격</option>
                  </select>
                  {detailStatus !== 'NIGHT_WORK' && siteType === 'ONSITE' && (
                    <p style={{ fontSize: 12, color: '#fbbf24', marginTop: -6, marginBottom: 10 }}>
                      ⚠️ 현장으로 등록하면, 이 작업을 마지막으로 퇴근할 때 위치 등록이 필수가 됩니다.
                    </p>
                  )}
                  <label className="field-label">작업인원(본인 외 추가 투입 인원, 선택)</label>
                  <input value={personnel} onChange={(e) => setPersonnel(e.target.value)} placeholder="예: 홍길동, 김철수" />
                </>
              )}

              <button
                disabled={
                  workDetail.trim().length < (detailStatus === 'HQ_WORKING' ? 15 : 10)
                  || (!SIMPLIFIED_EFFORT_STATUSES.has(detailStatus) && !workReason.trim())
                  || (detailStatus === 'HQ_WORKING' ? !clientName.trim() : !workStart)
                  // 고객사미팅/고객사작업은 위 workStart 조건과 별개로 고객사 선택(clientName)도 필수다
                  // (목록에서 고르거나 새로 등록해야 확정되므로, 검색창 글자만 입력한 상태로는 등록 불가).
                  || (LOCATION_CHECK_STATUSES.has(detailStatus) && !clientName.trim())
                  || (SITE_DETAIL_STATUSES.has(detailStatus) && !siteType)
                }
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
