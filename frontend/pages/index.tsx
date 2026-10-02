import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { apiFetch, clearToken } from '@/lib/api';
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush, isIOSDevice, isStandalonePWA } from '@/lib/push';
import { getCurrentLocationWithStatus, distanceMeters, reverseGeocode, isLowAccuracy, accuracyWarningLabel, LOCATION_JUMP_WARNING } from '@/lib/geolocation';
import { heroGreeting, clockOutGreeting, type WeatherInfo } from '@/lib/greetings';
import MandatoryConsentGate from '@/components/MandatoryConsentGate';
import ClockOutConfirmModal from '@/components/ClockOutConfirmModal';
import MapPickerModal from '@/components/MapPickerModal';
import SlideToConfirm from '@/components/SlideToConfirm';
import PastDayCorrectionCard, { type PendingCorrectionRow } from '@/components/PastDayCorrectionCard';
import CancelClockOutCard, { type CancelClockOutStatus } from '@/components/CancelClockOutCard';
import PilotFeedbackButton from '@/components/PilotFeedbackButton';

// 요청하신 배열: 재택/본사근무/고객사상주, 이동중/고객사미팅/고객사작업, 야간작업/대체휴무/휴가 (총 9개)
const STATUS_META: Record<string, { label: string; icon: string }> = {
  REMOTE: { label: '재택(집)', icon: '🏠' },
  HQ_WORKING: { label: '본사근무', icon: '🏢' },
  RESIDENT_ONSITE: { label: '고객사상주', icon: '🏬' },
  MOVING: { label: '이동중', icon: '🚙' },
  CLIENT_MEETING: { label: '고객사미팅', icon: '🤝' },
  CLIENT_WORK: { label: '고객사작업', icon: '🛠️' },
  NIGHT_WORK: { label: '야간작업', icon: '🌙' },
  // 2026-09-06: 주말(토/일) 전용 상태 — 주말엔 이 아이콘만 누를 수 있고 나머지는 잠긴다.
  WEEKEND_WORK: { label: '주말작업', icon: '🗓️' },
  BUSINESS_TRIP: { label: '출장', icon: '✈️' },
  ALT_DAY_OFF: { label: '대체휴무', icon: '🏖️' },
  ON_LEAVE: { label: '휴가', icon: '🌴' },
};
const STATUS_ORDER = ['REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK', 'BUSINESS_TRIP', 'ALT_DAY_OFF', 'ON_LEAVE'];

// 이 상태들은 클릭 시 오른쪽에 상세입력 폼을 띄운다.
const DETAIL_FORM_STATUSES = new Set([
  'REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK', 'BUSINESS_TRIP', 'ON_LEAVE', 'ALT_DAY_OFF',
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
// 추적한다. 백엔드 EFFORT_STATUSES와 원칙적으로 같은 값을 유지해야 하지만, WEEKEND_WORK만 예외다
// (2026-09-06) — 백엔드에서는 EffortLog로 시간을 구조화해서 남기지만, 화면은 "프로젝트명" 입력칸
// 없이 야간작업과 똑같은 모양을 유지하기로 해서 여기(프론트)에는 일부러 넣지 않았다.
const EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE']);
// 이 상태들은 "고객사명 + 업무내용"만 간단히 입력하는 단순폼이다(프로젝트/작업유형/시간 불필요).
// REMOTE는 접속시작~종료를 추적해야 해서 여기서 뺐다(2026-08-30, 엔지니어 공수 리포트 누락 문제 해결).
const SIMPLE_CLIENT_STATUSES = new Set(['RESIDENT_ONSITE']);
// 이 상태들은 "작업위치(원격/현장)"를 필수로, "작업인원/진행률·차수"를 선택으로 받는다 —
// 백업팀 등의 야간/고객사 작업 보고서 형식(예: VERITAS 야간작업 보고 메일)을 참고해 추가한 필드.
// 백엔드 attendance.routes.ts의 REQUIRE_SITE_TYPE_STATUSES와 반드시 같은 값을 유지해야 한다.
const SITE_DETAIL_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK']);
// 백엔드 LOCATION_CHECK_STATUSES와 동일 — 이 상태들은 고객사명이 필수다(비워두면 등록 자체가 막힘).
const LOCATION_CHECK_STATUSES = new Set(['CLIENT_MEETING', 'CLIENT_WORK']);
// 2026-09-19: 백엔드 LOCATION_CHECK_ELIGIBLE_STATUSES와 동일 — 야간작업/주말작업도 고객사미팅/
// 작업과 똑같은 "목록에서 선택 + 새 고객사는 지도로 등록" 화면을 쓰고, 고객사를 실제로 골랐고
// 현장(ONSITE)이면 위치까지 대조한다. 다만 이 둘은 고객사명이 필수는 아니라서(내부업무 허용)
// LOCATION_CHECK_STATUSES에는 넣지 않고, "이 화면을 보여줄지/위치캡처를 시도할지" 판단에만 쓴다.
const LOCATION_CHECK_ELIGIBLE_STATUSES = new Set([...LOCATION_CHECK_STATUSES, 'NIGHT_WORK', 'WEEKEND_WORK']);
// 2026-09-14: "고객작업과 야간작업 주말작업은 모두 시작시간과 끝나는 시간이 있어야 됩니다" 요청
// 반영 — 이 세 상태는 완료시간도 필수다(백엔드 REQUIRE_END_TIME_STATUSES와 동일하게 유지).
// 고객사미팅은 요청에서 제외되어 있어 기존처럼 완료시간 선택(진행중 허용)을 유지한다.
const END_TIME_REQUIRED_STATUSES = new Set(['CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK']);
// 2026-09-15: "시작~완료"가 있는 실제 작업 세션 상태 — 완료시간 없이(진행중) 등록해둔 뒤 폼을
// 다시 열면 이어받아 채워넣는다(백엔드 attendance.routes.ts EFFORT_CONTINUATION_STATUSES와 동일해야
// 함). 야간작업은 NightWorkSession으로 별도 관리되고(recordNightWork가 이미 올바르게 이어받음),
// "18시 이후 야간작업으로 이어가시겠어요?" 제안(acceptLateClockOutSuggestion)이 openDetailForm
// 직후 동기적으로 시작/완료시간을 직접 채워넣는 흐름과 겹쳐 여기서는 일부러 뺐다.
const EFFORT_CONTINUATION_STATUSES_FRONT = new Set(['CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'WEEKEND_WORK']);
// 물리적으로 다른 장소인 근무형태들 — 백엔드 attendance-helpers.ts의 LOCATION_TIED_STATUSES와
// 동일한 기준(REMOTE는 이동이 필요 없는 근무형태라 제외). 이 상태들 사이를 "이동중" 없이 곧장
// 넘나들면(예: 본사근무에서 바로 고객사작업으로) 잘못 누른 게 아닌지 한 번 되물어본다(2026-09-14).
const LOCATION_TIED_STATUSES_FRONT = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_WORK', 'CLIENT_MEETING']);
// 2026-09-20: 백엔드 attendance-helpers.ts의 WORK_START_STATUSES와 동일 — "그날 첫 근무상태
// 등록(=사실상 출근)"을 판단하는 기준. "GPS 캡처만 필수화"(대표이사 지침) 정책에 따라, 이
// 상태들 중 하나로 오늘 첫 등록을 할 때는 재택을 포함해 전부 GPS 캡처를 먼저 시도한다.
const WORK_START_STATUSES_FRONT = new Set(['HQ_WORKING', 'RESIDENT_ONSITE', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK', 'BUSINESS_TRIP', 'REMOTE']);
// 2026-09-01: 직원들이 등록을 귀찮아해서(항목이 너무 많음) 본사근무/고객사미팅/고객사작업 세 가지는
// 입력폼을 간소화했다 — 프로젝트명/목적·사유/진행률·차수 같은 부가 항목을 없애고, 실제로 꼭 필요한
// 항목(고객사·관련프로젝트, 수행업무)만 채우면 바로 등록되게 했다. 야간작업/재택은 기존 그대로 유지.
// 2026-09-01: 재택/야간작업도 같은 이유로 고객사작업과 같은 간소화된 형식으로 맞췄다 —
// 목적/사유 항목을 없애고, 진행률/차수(야간작업에만 있던 항목)도 없애서 형식을 통일했다.
const SIMPLIFIED_EFFORT_STATUSES = new Set(['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'REMOTE', 'NIGHT_WORK', 'WEEKEND_WORK']);

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
// simplifiedClientMeetingForm: true면 고객사미팅 입력폼을 "미팅시작·미팅목적·고객사" 3항목만
// 남기고(작업내용/작업위치 입력칸 자체를 없앰), 백엔드가 요구하는 값(작업위치·작업내용)은
// 화면에 묻지 않고 안전한 기본값으로 자동 채워 보낸다 — 2026-09-14 영업조직 요청.
type StatusOverride = { visibleStatuses: string[]; noFormStatuses: string[]; simplifiedClientMeetingForm?: boolean };

// 2026-09-04: BlL/Pre-Sales사업부(엔지니어링 계열) 요청 — 재택·본사근무는 버튼은 남기되 입력폼
// 없이 클릭만으로 등록되고, 그 외엔 고객사상주·이동중·고객사미팅·야간작업·출장·휴가만 있으면
// 된다(고객사작업/대체휴무는 안 보임 — 이 팀들은 고객사 방문 시 "고객사상주"로 등록하고 별도
// "고객사작업"은 안 쓴다는 전제). 2026-09-14: 보안/솔루션/arctera/Cohesity/DX사업부는 조직개편으로
// 영업 성격 사업부/사업본부로 재편되어 아래 SALES_OVERRIDE로 옮겼다(사용자 확인 완료).
const FIELD_ENGINEERING_OVERRIDE: StatusOverride = {
  // 2026-09-06: WEEKEND_WORK를 추가하지 않으면 이 override가 적용되는 부서는 주말에 누를 수
  // 있는 아이콘이 하나도 없어진다(나머지는 전부 주말 잠금 대상이므로) — 모든 override에 반드시
  // 포함시킨다.
  visibleStatuses: ['REMOTE', 'HQ_WORKING', 'RESIDENT_ONSITE', 'MOVING', 'CLIENT_MEETING', 'NIGHT_WORK', 'WEEKEND_WORK', 'BUSINESS_TRIP', 'ON_LEAVE'],
  noFormStatuses: ['REMOTE', 'HQ_WORKING'],
};

// 2026-09-14: 영업조직(공공사업본부/보안사업본부/솔루션사업부/Arctera사업부/Cohesity사업부/
// DX사업부/SI사업본부) 요청 — 본사출근·고객사미팅·이동중·출장·휴가 5개만 보이면 되고(고객사
// 상주·고객사작업·야간작업·주말작업·대체휴무는 안 씀), 고객사미팅도 미팅시작·미팅목적·고객사만
// 입력하면 되게 최대한 간소화해달라고 함.
const SALES_OVERRIDE: StatusOverride = {
  visibleStatuses: ['HQ_WORKING', 'MOVING', 'CLIENT_MEETING', 'BUSINESS_TRIP', 'ON_LEAVE'],
  noFormStatuses: ['HQ_WORKING'],
  simplifiedClientMeetingForm: true,
};

const DEPARTMENT_STATUS_OVERRIDES: Record<string, StatusOverride> = {
  경영관리부: {
    // WEEKEND_WORK 포함 이유는 FIELD_ENGINEERING_OVERRIDE 주석 참고.
    visibleStatuses: ['REMOTE', 'HQ_WORKING', 'MOVING', 'WEEKEND_WORK', 'BUSINESS_TRIP', 'ON_LEAVE'],
    noFormStatuses: ['HQ_WORKING'],
  },
  BlL사업부: FIELD_ENGINEERING_OVERRIDE,
  // 다우오피스 동기화 부서명이 대시보드에 "Pre-Sales사업부"(대문자 S)로 표시되는 걸 확인해서
  // 그 표기를 그대로 맞췄다(요청 메시지의 "Pre-sales"와 대소문자가 다름 — 정확히 일치해야
  // 적용되므로 실제 동기화 표기를 우선했다).
  'Pre-Sales사업부': FIELD_ENGINEERING_OVERRIDE,
  공공사업본부: SALES_OVERRIDE,
  보안사업본부: SALES_OVERRIDE,
  솔루션사업부: SALES_OVERRIDE,
  Arctera사업부: SALES_OVERRIDE,
  Cohesity사업부: SALES_OVERRIDE,
  DX사업부: SALES_OVERRIDE,
  SI사업본부: SALES_OVERRIDE,
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
interface StatusLog { status: string; changedAt: string; source: string; note: string | null; siteType: string | null; }
interface MeAttendance {
  record: { clockInAt: string | null; clockOutAt: string | null } | null;
  latestStatus: StatusLog | null;
  // 고객사작업/미팅 중일 때만 채워진다 — 위치이탈 자동감지가 "지금 근무중인 고객사"를 알아내는 데 쓴다.
  latestEffort: { clientName: string } | null;
  // 정규 근무 마감 정책시각(기본 18) — "정규 근무시간이 지났는데 아직 퇴근 전" 배너 판단에 쓴다.
  regularWorkEndHour: number;
}
interface WeeklySummary { from: string; to: string; totalMinutes: number; days: number; }
// ESD 2.0 (2026-10-01 추가)
interface ProjectOption {
  id: string; code: string; name: string; status: string;
  client: { id: string; name: string } | null;
  tasks: { id: string; title: string; status: string; assigneeId: string | null }[];
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ISO 시각 문자열을 TimeSelectInput이 쓰는 "HH:MM" 형식으로 바꾼다(이어받기 시작시각 표시용). */
function isoToHHMM(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** submitDetailForm이 만드는 "workDetail (목적: workReason)\n작업인원: ..." 형태의 합쳐진
 * description을 이어받기 위해 다시 나눈다. 이 형식은 프론트가 스스로 만든 것이라(자유서술 텍스트가
 * 우연히 같은 패턴일 위험이 거의 없음) 정규식으로 역분리해도 안전하다 — 2026-09-15 "진행중" 이어받기용. */
function parseComposedDescription(raw: string): { workDetail: string; workReason: string; personnel: string } {
  const lines = raw.split('\n');
  let first = lines[0] ?? '';
  let workReason = '';
  const m = first.match(/^(.*) \(목적: (.*)\)$/);
  if (m) {
    first = m[1];
    workReason = m[2];
  }
  let personnel = '';
  for (const line of lines.slice(1)) {
    const pm = line.match(/^작업인원: (.*)$/);
    if (pm) personnel = pm[1];
  }
  return { workDetail: first, workReason, personnel };
}

// 2026-09-14: 네이티브 <input type="time">가 기기(특히 안드로이드)에 따라 시계/스피너 모양으로
// 나와서 "누르기 불편하다"는 의견 — 시/분을 각각 드롭다운으로 고르는 방식으로 바꿔서 손가락으로
// 탭만 하면 되게 했다.
const TIME_SELECT_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const TIME_SELECT_MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

/**
 * "HH:MM" 문자열을 시/분 드롭다운 두 개로 입력받는다 — 기존 <input type="time">과 값 형식은
 * 그대로 "HH:MM"이라 다른 코드는 손댈 필요가 없다. allowEmpty가 true면 맨 앞에 "미정(진행중)"을
 * 넣어서 완료시간처럼 비워둘 수 있는 필드에도 쓸 수 있게 한다. 현재 값의 분이 5분 단위가 아니어도
 * (예: 지금 시각 자동입력) 목록에서 사라지지 않도록 그 값을 옵션에 끼워넣는다.
 */
function TimeSelectInput({ value, onChange, allowEmpty }: { value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const [hPart, mPart] = value ? value.split(':') : ['', ''];
  const hourList = hPart && !TIME_SELECT_HOURS.includes(hPart) ? [hPart, ...TIME_SELECT_HOURS] : TIME_SELECT_HOURS;
  const minuteList = mPart && !TIME_SELECT_MINUTES.includes(mPart) ? [mPart, ...TIME_SELECT_MINUTES] : TIME_SELECT_MINUTES;
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <select
        className="field-select"
        style={{ flex: 1 }}
        value={hPart}
        onChange={(e) => {
          const newH = e.target.value;
          onChange(newH ? `${newH}:${mPart || '00'}` : '');
        }}
      >
        {allowEmpty && <option value="">미정(진행중)</option>}
        {hourList.map((hh) => (
          <option key={hh} value={hh}>{hh}시</option>
        ))}
      </select>
      <select
        className="field-select"
        style={{ flex: 1 }}
        value={mPart}
        disabled={!hPart}
        onChange={(e) => onChange(`${hPart}:${e.target.value}`)}
      >
        {!hPart && <option value="">-</option>}
        {minuteList.map((mm) => (
          <option key={mm} value={mm}>{mm}분</option>
        ))}
      </select>
    </div>
  );
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
  // 2026-09-08: 아이콘이 화면에서 자꾸 잘못 눌리고(가방/주머니 속 터치 등) 10분 내에 되돌리지 않으면
  // 그대로 확정돼버리는 사고가 반복돼서(예: 야간에 상태가 계속 바뀌어 타임라인이 지저분해짐), 즉시등록
  // 상태(QUICK_REGISTER_STATUSES)는 아이콘을 눌러도 바로 등록하지 않고 "정말 이 상태로 확정할까요?"
  // 라는 가벼운 확인 질문을 한 번 거치게 한다 — 세부내용을 입력하는 폼이 아니라 예/아니오만 누르면
  // 되는 팝업이라 기존의 "즉시등록 후 나중에 세부내용 입력" 흐름 자체는 그대로 유지된다.
  const [pendingQuickConfirm, setPendingQuickConfirm] = useState<{ code: string; prefilledClientName?: string } | null>(null);
  // 2026-09-14: "본사근무>이동중>고객사작업"처럼 보통 이동중을 거쳐서 다른 근무장소로 넘어가는
  // 흔한 흐름과 다르게, 이동중 없이 근무장소 상태에서 바로 다른 근무장소 상태로 건너뛰면 혹시
  // 잘못 누른 게 아닌지 한 번 되물어본다(요청사항 — 정해진 시나리오를 벗어나면 재확인).
  const [pendingSequenceConfirm, setPendingSequenceConfirm] = useState<{ code: string; prefilledClientName?: string; fromLabel: string; toLabel: string } | null>(null);
  const [lateClockOutSuggestion, setLateClockOutSuggestion] = useState<{ overMinutes: number; suggestedStart: string; suggestedEnd: string } | null>(null);
  // 2026-09-06: 정규 근무시간(정책값, 기본 18시)이 지났는데 아직 퇴근 전이면 "퇴근하고 야간작업으로
  // 이어가기"를 안내하는 배너 — 저녁 6시부터 5분마다 오는 퇴근 푸시알림을 계속 미루게 되는 문제를
  // 보완한다(직접 퇴근을 눌러야 그 알림이 멈추므로, 야간작업으로 이어갈 계획이어도 일단 퇴근부터
  // 눌러 정규 근무를 마감하도록 유도). 오늘 하루만 닫아두는 스누즈.
  const [nightWorkPromptDismissed, setNightWorkPromptDismissed] = useState(false);
  // 이 배너의 버튼으로 퇴근 모달을 열었는지 — 그 경우에만 퇴근 확정 직후 야간작업 상세폼으로
  // 곧장 이어준다. 평범한 "퇴근" 버튼으로 연 경우는 기존 방식대로, 18시 이후 초과분이 있을 때만
  // 서버가 계산해준 lateClockOutSuggestion 배너를 보여준다.
  const [clockOutThenNightWork, setClockOutThenNightWork] = useState(false);
  // 위 배너가 "지금이 정규 근무 마감시각을 지났는지"를 최신 상태로 판단할 수 있도록 1분마다 갱신한다.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const [clientLocations, setClientLocations] = useState<{ name: string; latitude: number; longitude: number }[]>([]);
  const [arrivedClient, setArrivedClient] = useState<string | null>(null);
  // 고객사미팅/고객사작업 등록 시 검색·선택하는 전체 고객사 목록(좌표 유무 무관) — 2026-09-02 추가.
  const [clientOptions, setClientOptions] = useState<{ id: string; name: string; address?: string }[]>([]);
  // 2026-09-04: 목록을 못 불러온 건지(네트워크 오류) 아니면 진짜로 등록된 고객사가 없는 건지
  // 화면에서 구분이 안 돼서 "목록이 안 보여요" 문의가 들어옴 — 원인 파악용으로 구분해서 보여준다.
  const [clientOptionsError, setClientOptionsError] = useState(false);
  // 2026-09-18: "최근 등록한 고객사가 매번 위로 오면 좋겠다"(관리자 요청) — 이 직원이 최근에
  // 실제로 등록했던 고객사(본인 것만, 최신순)를 검색창 위 원탭 칩으로도, 목록 맨 위 고정으로도
  // 쓴다(recentClientOptions, filteredClientOptions 참고).
  const [recentClients, setRecentClients] = useState<{ id: string; name: string }[]>([]);
  const [clientQuery, setClientQuery] = useState('');
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const [addingClientBusy, setAddingClientBusy] = useState(false);
  // 2026-09-19: 신규 고객사는 이름만으로 바로 등록되지 않고, 이 상태가 채워지면 admin/clients.tsx
  // 에서도 이미 쓰고 있는 MapPickerModal(카카오맵 검색+클릭 선택)이 뜬다 — "위치 미확인" 원인
  // 분석 중 발견한 문제(현장 즉석등록 고객사가 좌표 없이 남는 것)를 근본적으로 막기 위한 조치.
  const [clientLocationPicker, setClientLocationPicker] = useState<{ name: string } | null>(null);
  // 2026-10-01 추가: 위치 불일치로 "예외 등록"된 직후, 그 자리에서 바로 카카오맵으로 본인 위치를
  // 확인/보정해 재등록할 수 있게 하는 흐름 — MapPickerModal의 initialCoords prop(2026-09-30,
  // "위치 불일치 시 카카오맵으로 직접 확인" 용도로 이미 만들어져 있었으나 어디서도 호출되지 않고
  // 있었다)을 여기서 처음 실제로 연결한다. body/code는 방금 보낸 요청을 그대로 다시 쓰기 위해
  // 들고 있는다(같은 날 같은 상태 재제출이면 서버가 기존 기록을 새로 만들지 않고 갱신한다 —
  // attendance.routes.ts의 willUpdateExistingEffort/willResumeNightWork 참고).
  const [locationCorrection, setLocationCorrection] = useState<{
    code: string;
    body: Record<string, unknown>;
    lat: number;
    lng: number;
    // 2026-10-02 추가(하드블록 재도입): true면 "최초 등록 자체가 막혀서" 뜬 모달 — 확정하면
    // retryBlockedStatusWithSelfConfirm으로 selfConfirmMismatch를 붙여 재시도한다. 없으면(기존
    // 2026-10-01 흐름) "일단 예외로 등록된 뒤" 뜬 모달이라 resubmitWithCorrectedLocation으로
    // 기존 기록을 갱신한다 — 같은 모달 UI를 두 시점에서 재사용하기 위한 구분.
    blocked?: boolean;
  } | null>(null);
  const [locationCorrectionBusy, setLocationCorrectionBusy] = useState(false);
  // 서버가 "정정 범위 초과"(LOCATION_CORRECTION_TOO_FAR) 등으로 거부한 사유 — 지도 모달이
  // 전체화면이라 바깥 메시지 배너가 안 보이므로, 모달 안에 바로 보여준다(닫지 않고 다시 시도 가능).
  const [locationCorrectionError, setLocationCorrectionError] = useState<string | null>(null);
  const hqPromptSnoozedUntilRef = useRef(0);
  const clientPromptSnoozedUntilRef = useRef(0);
  // 마지막 근무위치(본사/고객사) 이탈 감지용 — 계속 벗어나 있는 시간을 재기 위한 시작시각과,
  // "아직 근무중이에요"로 오탐 처리했을 때 잠시 다시 안 물어보게 하는 스누즈 시각.
  const departureAwaySinceRef = useRef<{ anchorKey: string; since: number } | null>(null);
  const departureSnoozedUntilRef = useRef(0);
  const [departureSuggestion, setDepartureSuggestion] = useState<{ correctionRequestId: string; estimatedAt: string } | null>(null);
  // 2026-09-08: 위치이탈 자동감지 확정도 수동 퇴근과 동일하게 최소근무시간 규칙이 적용돼서, 서버가
  // EARLY_LEAVE_REASON_REQUIRED로 거절하면 그 자리에서 사유를 입력받아 다시 시도할 수 있게 한다.
  const [departureNeedsReason, setDepartureNeedsReason] = useState(false);
  const [departureEarlyLeaveReason, setDepartureEarlyLeaveReason] = useState('');
  // 2026-09-23: "고객사작업 위치이탈 자동감지"(대표이사 요청 — 엔지니어 관리 편의를 위해 확인
  // 대기 없이 바로 반영하기로 변경). 고객사작업 중 마지막 근무위치를 30분 이상 벗어나면, 위 하루
  // 전체 퇴근 제안과 달리 본인 확인을 기다리지 않고 그 즉시 그 고객사작업 건의 종료시간을 채우고
  // "이동중"으로 전환한다(관리자가 바로 확인할 수 있는 "1차 로그"). 본인은 그 사실을 안내 배너로
  // 통보받고, 실제와 다르면(아직 작업중이었다면) 아래 "상태 정정" 메뉴에서 사유를 입력해 바로잡는다
  // — 하루 근태(clockOutAt)에는 손대지 않으므로 최소근무시간 등 퇴근 관련 규칙과는 무관하다.
  const [effortDepartureNotice, setEffortDepartureNotice] = useState<{ estimatedAt: string } | null>(null);
  // 2026-09-15: 관리자가 상황판에서 보낸 짧은 메시지(위치 불일치 등 확인 요청) — 안 읽은 것만
  // 주기적으로 받아와 배너로 보여준다. 이미 등록된 푸시로도 즉시 알림이 가지만(sw.js), 앱을
  // 열었을 때도 놓치지 않도록 여기서 한 번 더 보여준다. messages.routes.ts 참고.
  const [adminMessages, setAdminMessages] = useState<{ id: string; message: string; sentByName: string; createdAt: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [myStatus, setMyStatus] = useState<MeAttendance | null>(null);
  const currentStatus = myStatus?.latestStatus;
  const clockedOut = Boolean(myStatus?.record?.clockOutAt);
  // 정규 근무 마감시각(정책값, 기본 18시)이 지났는데 아직 퇴근 전인지 — 자정을 넘겨 계속
  // 일하는 경우까지 고려해 새벽 3시 전까지는 "저녁 시간대"로 본다(서버의 야간작업 허용시간
  // 판단과 동일한 기준, attendance.routes.ts DAY_BOUNDARY_HOUR 참고).
  const kstHourNow = (new Date(nowTick).getUTCHours() + 9) % 24;
  const regularWorkEndHour = myStatus?.regularWorkEndHour ?? 18;
  const isPastRegularWorkEnd = kstHourNow >= regularWorkEndHour || kstHourNow < 3;
  // 주말(토/일) 여부 — 2026-09-30 수정: 서버는 "근무일(새벽 3시 경계)" 기준으로 주말을 판정하는데
  // (attendance.routes.ts isWeekendForWorkDate), 여기만 자정 기준 달력요일을 쓰고 있어 금요일
  // 심야~토요일 03시 사이에 서버는 평일로, 화면은 주말로 서로 다르게 판단했다. 그 시간대엔 화면이
  // "주말작업"만 남기고 나머지를 전부 잠그는데 서버는 "주말작업"을 거부해서(WEEKEND_WORK_ONLY_ON_WEEKEND)
  // 어떤 상태도 등록할 수 없는 막다른 상태가 됐다 — 서버의 todayDateOnly()와 같은 오프셋(9-3=6시간)을
  // 써서 근무일 기준 요일을 구한다.
  const isWeekendToday = (() => {
    const workDateShifted = new Date(nowTick + 6 * 60 * 60 * 1000);
    const kstDay = workDateShifted.getUTCDay();
    return kstDay === 0 || kstDay === 6;
  })();
  // 주말엔 "퇴근하고 야간작업으로" 배너가 의미가 없다(주말작업은 애초에 정규 근무시간 개념이
  // 없고, 버튼을 눌러도 서버가 평일 전용인 야간작업 등록을 막아버린다) — 평일에만 띄운다.
  const showNightWorkTransitionPrompt = Boolean(
    myStatus?.record?.clockInAt && !clockedOut && isPastRegularWorkEnd && !nightWorkPromptDismissed && !isWeekendToday
  );
  // 관리자 권한 계정은 퇴근 후에도 테스트할 수 있게 상태변경 잠금에서 예외로 둔다.
  const isAdminAccount = Boolean(me?.roles?.some((r) => ['SYSTEM_ADMIN', 'HR_ADMIN'].includes(r)));
  // 2026-09-20: "감사인 계정은 따로 빼서"(대표이사 요청) — 재택 위치 열람은 이 메인 화면의 일반
  // 로그인과 완전히 분리된 별도 경로(/audit-login → /audit)로만 접근한다. 여기서 버튼으로
  // 연결하면 "따로 뺀" 의미가 없어지므로 의도적으로 이 화면에는 어떤 진입점도 두지 않는다.
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

  // 2026-09-23: "본인 상태 정정" — 다른 상태를 잘못 눌러 확정해버렸는데 되돌리기(10분 제한)로도
  // 더 이상 못 고치는 경우, 본인이 사유를 남기고 직접 오늘 상태를 바로잡을 수 있게 한다(윤혜선
  // 사원 사례 — 휴가인데 본사출근을 잘못 눌러버림). 위 아이콘 한 번 탭으로 즉시등록되는 평소
  // 흐름과 헷갈리지 않도록, 별도의 "상태 정정" 메뉴로 분리해서 사유 입력을 거치게 한다.
  const [showCorrectionModal, setShowCorrectionModal] = useState(false);
  const [correctionStatus, setCorrectionStatus] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [submittingCorrection, setSubmittingCorrection] = useState(false);

  // 고객사미팅/고객사작업/야간작업 공용 상세입력 폼 상태
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  // 2026-09-30: submitDetailForm이 위치확인(GPS+역지오코딩, 수 초 소요 가능)을 기다리는 동안에도
  // "등록" 버튼이 계속 눌려있어, 그 사이 빠르게 두 번 누르면(iOS에서 위치 확인이 느릴 때 특히)
  // 상태변경/공수기록이 중복 생성될 수 있었다 — submittingCorrection과 동일한 패턴으로 막는다.
  const [detailSubmitting, setDetailSubmitting] = useState(false);
  // 2026-09-30: 수동 "출근" 버튼도 같은 이유(GPS 확보 대기 중 버튼이 계속 활성)로 중복 클릭 시
  // /attendance/clock-in이 두 번 호출될 수 있었다 — myStatus.record.clockInAt은 refreshMyStatus()가
  // 끝나야 채워지므로 그것만으로는 두 번째 클릭을 못 막는다.
  const [clockInSubmitting, setClockInSubmitting] = useState(false);
  const [clientName, setClientName] = useState('');
  // 목록에서 정확히 고른 고객사의 id — 같은 이름을 포함하는 지점이 여러 곳(예: "김앤장법률사무소"
  // 본점/세양센터/국원센터)이어도 서버가 이름 부분일치 대신 이 id로 정확히 그 지점만 조회하도록
  // 같이 보낸다(2026-09-08). 직접 타이핑했거나 새로 등록한 직후처럼 목록에서 고르지 않은 경우엔
  // 빈 값으로 두고, 서버가 기존처럼 이름 부분일치로 대체 조회한다.
  const [clientId, setClientId] = useState('');
  const [projectName, setProjectName] = useState('');
  // ESD 2.0 (2026-10-01 추가): 기존 자유문자 projectName은 호환용으로 그대로 유지하고, 등록된
  // 프로젝트/Task를 선택하면 구조화된 projectId/taskId도 함께 저장한다.
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [workStart, setWorkStart] = useState(nowHHMM());
  const [workEnd, setWorkEnd] = useState('');
  // 2026-09-15: 박준영/이보용 피드백 — 고객사작업 등 완료시간 필수 상태인데 언제 끝날지 몰라 등록
  // 자체를 못 하는 문제. 완료시간 필수 정책(END_TIME_REQUIRED_STATUSES)은 유지하되, 이 체크박스를
  // 명시적으로 켠 경우에만 완료시간 없이 "진행중"으로 등록할 수 있게 예외를 둔다.
  const [stillInProgress, setStillInProgress] = useState(false);
  // 2026-09-15: 박준영/이보용님 재확인 피드백 — "진행중"으로 등록해두고 나중에 완료시간을 넣으려고
  // 다시 폼을 열면 처음부터 새로 입력해야 했다. 이전에 남겨둔 진행중 기록을 찾으면 이 문구로
  // 알려주고, 그 기록의 내용으로 폼을 채워넣는다(openDetailForm 참고).
  const [continuedNotice, setContinuedNotice] = useState<string | null>(null);
  const [workType, setWorkType] = useState(WORK_TYPE_OPTIONS[0]);
  const [workDetail, setWorkDetail] = useState('');
  const [workReason, setWorkReason] = useState(''); // 육하원칙 중 "왜(목적/사유)"
  // 작업위치(원격/현장, 필수) · 작업인원(추가 투입 인원, 선택) · 진행률/차수(선택)
  const [siteType, setSiteType] = useState<'ONSITE' | 'REMOTE'>('ONSITE');
  const [personnel, setPersonnel] = useState('');
  const [progressStage, setProgressStage] = useState('');
  // 2026-09-14: 고객사미팅/고객사작업 폼 입력항목이 너무 많다는 의견 — 필수가 아닌 항목
  // (프로젝트명/완료시간/작업인원)은 기본으로 접어두고, 필요할 때만 펼쳐서 입력하게 한다.
  const [showMoreFields, setShowMoreFields] = useState(false);
  // 2026-09-14: 영업조직(SALES_OVERRIDE) 요청 — 고객사미팅 폼에서 작업내용(미팅주제)·작업위치
  // 입력칸 자체를 없애고 미팅시작·미팅목적·고객사 3항목만 남긴다. submitDetailForm이 화면에
  // 안 보이는 두 값을 기본값으로 채워 보낸다(isSimplifiedMeeting 참고).
  const isSimplifiedMeetingForm = detailStatus === 'CLIENT_MEETING' && Boolean(deptStatusOverride?.simplifiedClientMeetingForm);
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
  // 진행중 공수 이어받기 조회의 요청 번호 — 늦게 도착한 옛 응답이 지금 열려 있는 폼을 덮지 않게.
  const detailFormRequestRef = useRef(0);
  useEffect(() => {
    apiFetch<ProjectOption[]>('/projects/options')
      .then((rows) => setProjectOptions(Array.isArray(rows) ? rows : []))
      .catch(() => setProjectOptions([]));
  }, []);
  const selectedProject = projectOptions.find((p) => p.id === projectId) ?? null;
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  // 2026-09-03 추가, 2026-09-19 변경: 처음엔 "네, 알림 받을게요" 배너로 먼저 동의를 구했는데,
  // 그 배너를 안 누르고 넘어가는 직원이 많아 알림 미설정 인원이 계속 쌓였다("앱 열 때마다 기본으로
  // 켜져 있고, 끄고 싶으면 직접 끄게 해달라"는 요청) — 이제 앱을 열면 자동으로 알림 켜기를
  // 시도하고, 끄는 것만 사용자가 직접 선택하게 한다. iOS(사파리)는 홈 화면에 추가한 앱이 아니면
  // 애초에 PushManager 자체가 없어서 자동으로 켤 수 없으므로, 그 경우에만 설치 안내 배너를 남긴다.
  const [showIosInstallPrompt, setShowIosInstallPrompt] = useState(false);
  // 2026-09-04: 아이폰 사파리는 홈 화면에 추가한 앱(standalone)에서만 알림을 지원한다(iOS 정책).
  // 이 경우 알림 켜기 버튼을 눌러도 항상 실패하므로, 미리 감지해서 버튼 문구/동작을 안내로 바꾼다.
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [pendingCorrections, setPendingCorrections] = useState<PendingCorrectionRow[]>([]);
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  // 아직 신청조차 안 했거나, 신청했다가 반려된 지난 근무일이 하나라도 있으면 상태 아이콘을 잠근다.
  // 승인 대기중(PENDING)인 것은 이미 본인이 조치했으므로 잠그지 않는다.
  const mustResolvePastCorrection = pendingCorrections.some((r) => !r.latestRequest || r.latestRequest.status === 'REJECTED');
  // 2026-09-16: 오늘 퇴근을 잘못 눌렀을 때의 "퇴근 취소 신청" 최신 상태(CancelClockOutCard 참고).
  const [cancelClockOutStatus, setCancelClockOutStatus] = useState<CancelClockOutStatus | null>(null);

  // 2026-09-30 수정(Medium): 이 함수는 상태 변경·정정·정정신청 등 여러 경로에서 호출되는데 요청
  // 번호 가드가 없어서, 빠르게 두 번 호출되면 먼저 보낸 요청의 늦은 응답이 최신 상태를 덮어써
  // 화면의 "지금 상태"가 예전 값으로 되돌아갈 수 있었다(다른 화면들은 a10b7c8에서 같은 가드를 받았다).
  const myStatusRequestRef = useRef(0);
  function refreshMyStatus() {
    const requestId = ++myStatusRequestRef.current;
    const apply = <T,>(setter: (v: T) => void) => (v: T) => {
      if (myStatusRequestRef.current === requestId) setter(v);
    };
    apiFetch<MeAttendance>('/attendance/me').then(apply(setMyStatus)).catch(() => {});
    apiFetch<WeeklySummary>('/attendance/me/weekly').then(apply(setWeekly)).catch(() => {});
    apiFetch<PendingCorrectionRow[]>('/attendance-correction/pending').then(apply(setPendingCorrections)).catch(() => {});
    apiFetch<CancelClockOutStatus | null>('/attendance-correction/cancel-clock-out/today').then(apply(setCancelClockOutStatus)).catch(() => {});
  }

  useEffect(() => {
    const needsInstall = isIOSDevice() && !isStandalonePWA();
    setIosNeedsInstall(needsInstall);
    isPushSubscribed().then((subscribed) => {
      setPushSubscribed(subscribed);
      if (subscribed || typeof window === 'undefined') return;
      if (needsInstall) {
        // 아이폰 사파리는 홈 화면에 추가한 앱이 아니면 PushManager 자체가 없어 자동으로 켤 수
        // 없다 — 설치 안내만 보여준다(세션당 한 번, "알겠어요"로 닫으면 다시 안 뜸).
        try {
          if (sessionStorage.getItem('iosInstallPromptDismissed')) return;
        } catch {}
        setShowIosInstallPrompt(true);
        return;
      }
      // 브라우저 알림권한이 아직 한 번도 물어본 적 없는 상태(default)일 때만 자동으로 켠다 —
      // 이미 거부(denied)한 사람에게는 브라우저가 재요청 자체를 막으므로 어차피 조용히 실패하고,
      // 이미 허용(granted)된 상태인데 구독만 없으면 subscribeToPush()가 팝업 없이 바로 구독한다.
      if (!('Notification' in window) || Notification.permission !== 'default') return;
      subscribeToPush()
        .then(() => setPushSubscribed(true))
        // 자동 시도라 실패해도(권한 거부 등) 매번 에러 메시지를 띄우지 않는다 — 알림 끄기/켜기는
        // 화면 하단 버튼으로 언제든 다시 시도할 수 있다.
        .catch(() => {});
    }).catch(() => {});
  }, []);

  function dismissIosInstallPrompt() {
    setShowIosInstallPrompt(false);
    try {
      sessionStorage.setItem('iosInstallPromptDismissed', '1');
    } catch {}
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

  // 관리자가 보낸 메시지(안 읽은 것만) — 1분마다 확인. 푸시가 안 왔거나(미구독) 이미 앱을 켜둔
  // 상태에서 보낸 경우까지 놓치지 않게 폴링으로도 받아온다.
  useEffect(() => {
    function loadAdminMessages() {
      apiFetch<{ id: string; message: string; sentByName: string; createdAt: string }[]>('/messages/unread')
        .then(setAdminMessages)
        .catch(() => {});
    }
    loadAdminMessages();
    const id = setInterval(loadAdminMessages, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  async function dismissAdminMessage(id: string) {
    setAdminMessages((prev) => prev.filter((m) => m.id !== id));
    try {
      await apiFetch(`/messages/${id}/read`, { method: 'POST' });
    } catch {
      // 실패해도 조용히 넘어간다 — 다음 폴링 때 다시 나타날 뿐이다.
    }
  }

  // 2026-09-15: "양방향으로 답장할 수 있으면 좋겠다"는 요청 반영 — 배너에서 바로 답장을 입력해
  // 보낼 수 있다. 메시지 id별로 입력중인 답장 초안을 따로 들고 있는다.
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replySending, setReplySending] = useState<Record<string, boolean>>({});

  async function sendReplyToMessage(id: string) {
    const text = (replyDrafts[id] || '').trim();
    if (!text) return;
    setReplySending((prev) => ({ ...prev, [id]: true }));
    try {
      await apiFetch('/messages/reply', { method: 'POST', body: JSON.stringify({ message: text }) });
      setReplyDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      // 답장을 보냈으면 확인도 같이 처리하고 배너를 닫는다.
      await dismissAdminMessage(id);
    } catch {
      // 실패하면 배너와 입력한 텍스트를 그대로 남겨둬서 다시 시도할 수 있게 한다.
    } finally {
      setReplySending((prev) => ({ ...prev, [id]: false }));
    }
  }

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
    // 최근 등록한 고객사 — 없으면(신규 입사자 등) 그냥 빈 배열로 두고 기존처럼 전체 목록만 보여준다.
    apiFetch<{ id: string; name: string }[]>('/attendance/clients-recent')
      .then(setRecentClients)
      .catch(() => {});
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
      // 2026-09-20: 주말작업/야간작업은 "현장(ONSITE)"으로 등록된 경우엔 CLIENT_WORK/MEETING과
      // 마찬가지로 고정된 근무위치가 있다(고객사 현장, 또는 고객사 없이 본사에서 하는 내부업무) —
      // 대표이사 지적: 현장에서 30분 만에 작업이 끝나도 앱에서 "완료"를 늦게 누르면(예: 밤 10시)
      // 근무시간이 실제보다 부풀려지는데, 이 상태들은 이탈감지 대상에서 아예 빠져 있어서 다른
      // 상태(고객사작업/미팅 등)처럼 위치이탈로 자동 정정 제안이 뜨지 않았다. 원격(재택)은 집
      // 좌표가 없어 이탈감지 자체가 불가능하므로 그대로 제외한다.
      if ((currentStatus.status === 'NIGHT_WORK' || currentStatus.status === 'WEEKEND_WORK') && currentStatus.siteType === 'ONSITE') {
        const c = findClientCoords(clientLocations, latestEffortClientName);
        if (c) return { lat: c.latitude, lng: c.longitude };
        return hqLocation; // 고객사 없이 "내부업무"로 현장(본사) 등록한 경우 — 본사를 기준 위치로 삼는다.
      }
      return null; // 재택/이동중/출장은 고정된 근무위치가 없어 이탈감지 대상이 아니다.
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
      // 2026-09-30: 기존에는 오차범위를 전혀 안 보고(getCurrentLocation) 첫 GPS 응답을 그대로
      // 썼는데, 실내·이동 중에는 기지국/WiFi 기반으로 잡힌 부정확한 좌표(수백m~수km 오차)가 올 수
      // 있어 실제로는 300m 밖인데도 "도착하신 것 같아요" 배너가 뜨는 오탐이 발생했다(사용자 보고).
      // 다른 위치 확인 로직(출퇴근 등록 등)과 동일하게 getCurrentLocationWithStatus()로 바꿔
      // 오차범위가 낮은(신뢰 가능한) 좌표만 쓰고, 오차가 크면 이번 주기는 건너뛰고 다음 5분 주기에
      // 다시 시도한다 — 실제로 근처에 있으면 다음 시도에서도 계속 감지되므로 기능 자체는 그대로다.
      const { status: locStatus, coords: loc, accuracyMeters } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
      if (locStatus !== 'OK' || !loc || isLowAccuracy(accuracyMeters)) return;

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
      // 2026-09-23: 단, "고객사작업"만은 예외다 — 하루 전체 퇴근이 아니라 그 작업 건만 종료시간을
      // 채우고 "이동중"으로 넘어가는 개념이라, 관리자가 실제 작업시간을 놓치지 않도록(대표이사
      // 요청 — 엔지니어 관리 편의) 본인 확인을 기다리지 않고 감지 즉시 반영한다("1차 로그"). 본인은
      // 안내 배너로 통보받고, 실제와 다르면 "상태 정정" 메뉴에서 사유를 남기고 바로잡을 수 있다.
      if (anchor) {
        const dist = distanceMeters(loc.lat, loc.lng, anchor.lat, anchor.lng);
        const anchorKey = `${currentStatus?.status}:${currentStatus?.changedAt}`;
        if (dist > 300) {
          if (!departureAwaySinceRef.current || departureAwaySinceRef.current.anchorKey !== anchorKey) {
            departureAwaySinceRef.current = { anchorKey, since: Date.now() };
          } else if (Date.now() - departureAwaySinceRef.current.since >= DEPARTURE_AWAY_THRESHOLD_MS) {
            const estimatedAt = new Date(departureAwaySinceRef.current.since);
            if (currentStatus?.status === 'CLIENT_WORK') {
              try {
                await apiFetch('/attendance/effort-departure-confirm', {
                  method: 'POST',
                  body: JSON.stringify({ estimatedEndAt: estimatedAt.toISOString() }),
                });
                departureAwaySinceRef.current = null;
                setEffortDepartureNotice({ estimatedAt: estimatedAt.toISOString() });
                refreshMyStatus();
              } catch {
                // 실패해도 조용히 넘어간다 — 다음 5분 주기에 다시 시도된다.
              }
            } else {
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
      // 2026-10-02: 위치불일치 하드블록(LOCATION_MISMATCH_BLOCKED)은 withMismatchConfirm이 이미
      // "카카오맵으로 실제 위치 확인" 모달을 띄우는 등 처리를 끝냈다는 뜻으로 이 표식(silent)을
      // 남기고 다시 던진다 — 여기서 또 오류 문구로 화면을 덮어쓰지 않는다.
      if ((err as Error & { silent?: boolean } | undefined)?.silent) return;
      setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
      setMessageIsError(true);
    }
  }

  /**
   * 2026-10-02 추가(위치 불일치 하드블록 재도입과 함께): 서버가 LOCATION_MISMATCH_BLOCKED로
   * 최초 등록 자체를 막으면, 오류로 표시하는 대신 기존 "카카오맵 위치 확인/정정" 모달
   * (locationCorrection, 2026-10-01에 이미 있던 컴포넌트)을 그 자리에서 띄운다 — blocked:true로
   * 표시해서 확정 시 retryBlockedStatusWithSelfConfirm(선택/보정한 좌표 + selfConfirmMismatch)을
   * 타도록 한다. body는 그대로 들고 있다가 재시도에 재사용한다(이번 요청에서 이미 측정된
   * body.location은 손대지 않는다 — 그게 "원본 GPS 지점"으로서 서버의 스푸핑 방지 검증 기준이
   * 된다).
   */
  async function withMismatchConfirm<T>(code: string, body: Record<string, unknown>, submit: () => Promise<T>): Promise<T> {
    try {
      return await submit();
    } catch (err) {
      const errCode = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      if (errCode !== 'LOCATION_MISMATCH_BLOCKED') throw err;
      const loc = body.location as { lat: number; lng: number } | undefined;
      if (loc) setLocationCorrection({ code, body, lat: loc.lat, lng: loc.lng, blocked: true });
      const silentErr = new Error(err instanceof Error ? err.message : '위치 확인이 필요합니다.');
      (silentErr as Error & { silent?: boolean }).silent = true;
      throw silentErr;
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

  function openCorrectionModal(presetStatus?: string) {
    setCorrectionStatus(
      presetStatus && STATUS_META[presetStatus]
        ? presetStatus
        : currentStatus?.status && STATUS_META[currentStatus.status]
          ? currentStatus.status
          : visibleStatusOrder[0]
    );
    setCorrectionReason('');
    setShowCorrectionModal(true);
  }

  function closeCorrectionModal() {
    if (submittingCorrection) return;
    setShowCorrectionModal(false);
  }

  async function submitCorrection() {
    if (!correctionReason.trim()) return;
    setSubmittingCorrection(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await apiFetch('/attendance/status/correct', {
        method: 'POST',
        body: JSON.stringify({ newStatus: correctionStatus, reason: correctionReason.trim() }),
      });
      setShowCorrectionModal(false);
      setMessage(`'${STATUS_META[correctionStatus]?.label ?? correctionStatus}'(으)로 상태를 정정했어요.`);
      refreshMyStatus();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '상태 정정에 실패했습니다.');
      setMessageIsError(true);
    } finally {
      setSubmittingCorrection(false);
    }
  }

  /**
   * 마지막 근무위치를 벗어난 지 30분이 지났을 때, 본인이 직접 확인하고 그 시각으로 퇴근을 확정한다.
   * 2026-09-08: 이렇게 확정되는 근무시간도 최소근무시간(정책값) 규칙 대상이라, 서버가
   * EARLY_LEAVE_REASON_REQUIRED로 거절하면 배너에 사유 입력창을 띄우고 여기서는 그대로 둔다 —
   * 사유를 입력하고 다시 누르면 그때 같이 실어 보낸다.
   */
  async function confirmDepartureSuggestion() {
    if (!departureSuggestion) return;
    const info = departureSuggestion;
    const reason = departureEarlyLeaveReason.trim();
    setMessage(null);
    setMessageIsError(false);
    try {
      await apiFetch('/attendance/departure-suggest/confirm', {
        method: 'POST',
        body: JSON.stringify({ correctionRequestId: info.correctionRequestId, ...(reason ? { earlyLeaveReason: reason } : {}) }),
      });
      setDepartureSuggestion(null);
      departureAwaySinceRef.current = null;
      setDepartureNeedsReason(false);
      setDepartureEarlyLeaveReason('');
      setMessage(`${fmtClock(info.estimatedAt)}에 퇴근하신 걸로 확정했어요. ${clockOutGreeting(weather)}`);
      refreshMyStatus();
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      if (code === 'EARLY_LEAVE_REASON_REQUIRED') {
        setDepartureNeedsReason(true);
      }
      setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
      setMessageIsError(true);
    }
  }

  /** "아직 근무중이에요" — 오탐이었다고 알려주면 대기중이던 제안을 취소한다. */
  function dismissDepartureSuggestion() {
    if (!departureSuggestion) return;
    const info = departureSuggestion;
    setDepartureSuggestion(null);
    departureAwaySinceRef.current = null;
    departureSnoozedUntilRef.current = Date.now() + 30 * 60 * 1000; // 30분 동안 다시 안 물어봄
    setDepartureNeedsReason(false);
    setDepartureEarlyLeaveReason('');
    apiFetch('/attendance/departure-suggest/dismiss', { method: 'POST', body: JSON.stringify({ correctionRequestId: info.correctionRequestId }) }).catch(() => {});
  }

  /** 위 "고객사작업 위치이탈 자동감지" 안내 배너를 닫는다(이미 반영은 감지 즉시 끝난 상태). */
  function dismissEffortDepartureNotice() {
    setEffortDepartureNotice(null);
  }

  /** 안내 배너에서 "잘못됐어요 — 정정하기"를 누르면, 상태 정정 모달을 '고객사작업'으로 미리 채워서 연다. */
  function openCorrectionFromEffortNotice() {
    setEffortDepartureNotice(null);
    openCorrectionModal('CLIENT_WORK');
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
    // 여기서 채워지는 이름은 목록에서 고른 게 아니라 이전 값을 그대로 복원한 것이라 어느 지점인지
    // 확정할 수 없다 — id는 비워두고, 제출 시 서버가 기존처럼 이름 부분일치로 대체 조회하게 한다.
    // 목록에서 다시 정확히 고르면 아래 콤보박스 선택 핸들러가 id를 채워준다.
    setClientId('');
    // 고객사미팅/고객사작업의 검색창 콤보박스도 같은 초기값으로 맞춰준다(예: GPS 도착감지로
    // 이미 고객사명이 채워진 경우, 검색창에도 바로 그 이름이 보이게).
    setClientQuery(initialClientName);
    setClientPickerOpen(false);
    setProjectName('');
    setProjectId('');
    setTaskId('');
    const initialWorkStart = nowHHMM();
    setWorkStart(initialWorkStart);
    setWorkEnd('');
    setStillInProgress(false);
    const initialWorkType = code === 'HQ_WORKING' ? HQ_WORK_TYPE_OPTIONS[0] : code === 'CLIENT_MEETING' ? MEETING_PURPOSE_OPTIONS[0] : WORK_TYPE_OPTIONS[0];
    setWorkType(initialWorkType);
    setWorkDetail('');
    setWorkReason('');
    setSiteType('ONSITE');
    setPersonnel('');
    setProgressStage('');
    setShowMoreFields(false);
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
    setContinuedNotice(null);
    // 모바일에서 폼이 화면 아래로 밀려서 "아무 반응 없다"고 느껴지지 않게, 폼으로 스크롤을 옮겨준다.
    setTimeout(() => detailFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

    // 2026-09-15: 고객사작업/고객사미팅/재택/주말작업은 "진행중"으로 남겨둔 이전 등록이 있으면
    // 이어받아 채워넣는다(박준영/이보용님 재확인 피드백 — 완료시간을 나중에 넣으려고 폼을 닫았다
    // 다시 열면 처음부터 새로 입력해야 해서 불편하다는 지적). 폼은 일단 위에서 빈 값으로 열고,
    // 있으면 비동기로 덮어쓴다. GPS 도착감지 등으로 이미 특정 고객사명이 넘어온 경우(prefilledClientName)
    // 는 그 값이 우선이라 고객사명만은 덮어쓰지 않는다.
    if (EFFORT_CONTINUATION_STATUSES_FRONT.has(code)) {
      // 2026-09-30 수정(Medium): 필드별 "아직 손대지 않았는지" 비교는 a10b7c8에서 들어갔지만
      // 요청 순서는 보장되지 않았다 — 폼 A를 열고 즉시 폼 B를 열면 A의 늦은 응답이 B 폼에 적용될
      // 수 있다(두 폼의 초기값이 같으면 비교 조건이 참이 되어 통과). 요청 번호로 최신 것만 반영한다.
      const detailRequestId = ++detailFormRequestRef.current;
      apiFetch<{ sourceStatus: string; clientName: string; projectName: string; projectId?: string | null; taskId?: string | null; workType: string; startTime: string; description: string } | null>(
        `/attendance/effort/in-progress?status=${code}`
      )
        .then((open) => {
          if (detailFormRequestRef.current !== detailRequestId) return;
          if (!open) return;
          const startHHMM = isoToHHMM(open.startTime);
          // 2026-09-22: 이 조회가 응답을 받기 전에 사용자가 이미 폼에 입력을 시작했다면 그
          // 내용을 덮어쓰지 않는다 — 느린 네트워크(고객사 현장 등)에서 이 응답이 늦게 도착하면
          // 방금 입력한 내용이 통째로 사라지는("입력창이 계속 초기화된다") 문제가 실제로
          // 보고됨(백해성님 사례). 필드별로 "폼을 연 직후의 초기값 그대로인지"를 확인해서, 아직
          // 손대지 않은 필드만 이어받은 값으로 채운다 — 사용자가 이미 입력한 필드는 그대로 둔다.
          if (!prefilledClientName && open.clientName) {
            setClientName((prev) => (prev === initialClientName ? open.clientName : prev));
            setClientQuery((prev) => (prev === initialClientName ? open.clientName : prev));
          }
          if (open.projectName) setProjectName((prev) => (prev === '' ? open.projectName : prev));
          if (open.projectId) setProjectId((prev) => (prev === '' ? open.projectId! : prev));
          if (open.taskId) setTaskId((prev) => (prev === '' ? open.taskId! : prev));
          if (open.workType) setWorkType((prev) => (prev === initialWorkType ? open.workType : prev));
          setWorkStart((prev) => (prev === initialWorkStart ? startHHMM : prev));
          const { workDetail: wd, workReason: wr, personnel: pn } = parseComposedDescription(open.description || '');
          if (wd) setWorkDetail((prev) => (prev === '' ? wd : prev));
          if (wr) setWorkReason((prev) => (prev === '' ? wr : prev));
          if (pn) setPersonnel((prev) => (prev === '' ? pn : prev));
          setContinuedNotice(`⏳ 진행중이던 작업을 이어서 불러왔어요(시작 ${startHHMM}). 끝나셨으면 완료시간을 입력하고 등록해주세요.`);
        })
        .catch(() => {});
    }
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

  async function changeStatus(code: string, prefilledClientName?: string, skipConfirm = false, skipSequenceCheck = false) {
    const alreadyInThisStatus = currentStatus?.status === code;

    // 2026-09-14: 본사근무>이동중>고객사작업/미팅처럼 흔한 흐름과 다르게, "이동중"을 거치지 않고
    // 근무장소 상태에서 곧장 다른 근무장소 상태로 건너뛰면 잘못 누른 건 아닌지 한 번 되물어본다.
    if (
      !skipSequenceCheck && !alreadyInThisStatus
      && currentStatus && LOCATION_TIED_STATUSES_FRONT.has(currentStatus.status)
      && LOCATION_TIED_STATUSES_FRONT.has(code)
    ) {
      setPendingSequenceConfirm({
        code,
        prefilledClientName,
        fromLabel: STATUS_META[currentStatus.status]?.label ?? currentStatus.status,
        toLabel: STATUS_META[code]?.label ?? code,
      });
      return;
    }

    // 즉시등록 상태(QUICK_REGISTER_STATUSES)를 처음 누르는 경우, 실수로 눌렸을 가능성을 막기 위해
    // 먼저 가벼운 확인 질문을 띄우고 여기서 멈춘다 — 사용자가 "예"를 누르면 그때 skipConfirm=true로
    // 이 함수를 다시 호출해 실제 등록을 진행한다. 이미 확인을 거쳤거나(skipConfirm) 이미 같은
    // 상태이거나, 애초에 즉시등록 대상이 아닌 상태(세부폼이 먼저 필요한 상태)는 그대로 통과시킨다.
    if (QUICK_REGISTER_STATUSES.has(code) && !alreadyInThisStatus && !skipConfirm) {
      setPendingQuickConfirm({ code, prefilledClientName });
      return;
    }
    // 새 상태를 등록한다는 건 본인이 여전히 활동중이라는 뜻이므로, 혹시 떠 있던 "퇴근 이탈감지"
    // 제안이 있다면 더 이상 맞지 않는 추정이니 같이 정리한다(오탐으로 조용히 취소).
    if (!alreadyInThisStatus && departureSuggestion) dismissDepartureSuggestion();
    if (!alreadyInThisStatus && effortDepartureNotice) setEffortDepartureNotice(null);
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
      if (['HQ_WORKING', 'CLIENT_MEETING', 'CLIENT_WORK', 'NIGHT_WORK', 'WEEKEND_WORK', 'REMOTE'].includes(code)) {
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
      const hqQuickLocationMeta: { accuracy: number | null; jumpDetected: boolean } = { accuracy: null, jumpDetected: false };
      const refreshHqQuickLocation = async () => {
        const { status: locStatus, coords, accuracyMeters, jumpDetected } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
        body.locationStatus = locStatus;
        hqQuickLocationMeta.accuracy = accuracyMeters;
        hqQuickLocationMeta.jumpDetected = jumpDetected;
        if (coords) {
          body.location = coords;
          // 2026-09-16: 이미 계산해뒀던 오차범위를 서버로도 함께 보낸다 — 서버가 "거리 - 오차범위
          // <= 반경"으로 반영해서, 반경 상수 자체를 계속 늘리지 않고도 정확도 낮은 측정을 봐줄 수
          // 있게 한다(위치 미확인/불일치 개선 1순위).
          // 2026-10-01 수정: 서버 zod 스키마(statusSchema)와 퀵 출근 엔드포인트 모두 필드명을
          // accuracyMeters로 읽는다(attendance.routes.ts) — locationAccuracyMeters라는 잘못된
          // 이름으로 보내고 있어서 서버가 이 값을 전혀 받지 못해(undefined로 무시됨) 오차범위
          // 봐주기(accuracyAllowanceMeters, 최대 1km)가 한 번도 적용된 적이 없었다(실데이터 확인:
          // location_accuracy_meters 컬럼이 전부 NULL). 필드명을 서버와 맞춘다.
          body.accuracyMeters = accuracyMeters ?? undefined;
          // 카카오맵 역지오코딩 — GPS 오차가 커도(예: 신한이노플렉스 사무실 835m 오차 사례) 주소가
          // 본사 건물명/도로명과 일치하면 서버에서 통과시켜줄 수 있게, 변환된 주소도 같이 보낸다.
          body.locationAddress = (await reverseGeocode(coords.lat, coords.lng)) ?? undefined;
        } else {
          delete body.location;
          delete body.locationAddress;
          delete body.accuracyMeters;
        }
      };
      // 2026-09-20: "직원 출근은 무조건 위치 대조를 강제해야 한다"(대표이사 지침) — 예전엔
      // 본사근무만 GPS를 미리 캡처했는데, 이제 재택을 포함한 모든 근무형태에서 "오늘 첫 등록"
      // 시점엔 GPS 캡처를 먼저 시도한다(서버도 동일하게 강제하므로, 여기서 안 하면 서버에서
      // 막혀 사용자가 다시 눌러야 하는 번거로움이 생긴다 — attemptWithLocationRetry가 실패 시
      // 재측정을 시도하긴 하지만, 애초에 시도조차 안 하는 것보단 미리 하는 게 매끄럽다).
      const isFirstStatusToday = !myStatus?.record?.clockInAt;
      // 2026-09-30 수정: 본사근무(HQ_WORKING)는 "오늘 첫 등록"이 아니어도 서버가 위치대조를
      // 시도하고 그 결과를 "하루 1회 봐주기" 집계에 넣는다(attendance.routes.ts). 첫 등록일 때만
      // 위치를 보내면, 하루에 본사근무를 여러 번 등록하는 직원(예: 본사→고객사→본사)은 서버가
      // 이 등록을 "위치 미확인"으로 세다가 결국 막히는데, 정작 앱에는 그 시점에 위치를 다시
      // 보낼 방법이 없어 갇히게 된다. 본사근무는 첫 등록이 아니어도 항상 캡처해서 보낸다.
      if ((isFirstStatusToday && WORK_START_STATUSES_FRONT.has(code)) || code === 'HQ_WORKING') {
        await refreshHqQuickLocation();
        // 이상치(순간이동) 감지는 본사근무처럼 대조할 고정 좌표가 있는 경우에만 의미가 있다
        // (getCurrentLocationWithStatus 내부에서 직전 위치와의 순간이동만 보므로, 재택 등
        // 대조 좌표가 없는 상태에서도 동일하게 동작 — 등록 자체를 막을 만큼 비정상적인
        // GPS 튐이면 상태와 무관하게 재측정을 유도하는 게 맞다).
        if (hqQuickLocationMeta.jumpDetected) {
          setMessage(LOCATION_JUMP_WARNING);
          setMessageIsError(true);
          return;
        }
      }
      // 부서 설정(DEPARTMENT_STATUS_OVERRIDES)에서 이 상태를 "세부폼 없이 등록만"으로 지정했으면,
      // 등록 즉시 끝난다 — 아래 세부입력폼을 아예 열지 않고, 안내 문구도 "입력해주세요"를 뺀다.
      const skipDetailForm = deptStatusOverride?.noFormStatuses.includes(code) ?? false;
      const accuracyWarningSuffix = isLowAccuracy(hqQuickLocationMeta.accuracy) ? ` (${accuracyWarningLabel(hqQuickLocationMeta.accuracy)})` : '';
      run(
        () =>
          withMismatchConfirm(code, body, () =>
            attemptWithLocationRetry(
              () => apiFetch('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
              isFirstStatusToday && WORK_START_STATUSES_FRONT.has(code) ? refreshHqQuickLocation : undefined
            )
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
            undoable?: boolean;
          } | null;
          // 2026-09-30(L-10): 기존 기록을 갱신한 재저장이면 되돌리기를 띄우지 않는다(원래 기록까지 지워지므로).
          if (res?.statusLog?.id && res.undoable !== false) {
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

  /** 즉시등록 확인 팝업에서 "네, 확정합니다"를 눌렀을 때 — 실제 등록을 진행한다.
   * 2026-09-15: 여기서 skipSequenceCheck를 안 넘겨(기본값 false) changeStatus를 다시 부르면,
   * 본사근무↔고객사상주처럼 "위치연동 상태끼리 직접 전환"이면서 "즉시등록 대상"이기도 한 상태는
   * 아직 상태가 안 바뀐 채로(currentStatus가 그대로라서) 흐름재확인(pendingSequenceConfirm)이
   * 다시 걸려 두 팝업이 서로를 계속 띄우는 무한루프가 생겼다(김진영님 "고객사 상주로 안 바뀜"
   * 피드백으로 발견). 이 팝업까지 왔다는 건 흐름 확인도 이미 끝났거나 애초에 필요 없었다는
   * 뜻이므로, 두 확인을 모두 건너뛰고 실제로 등록을 진행한다. */
  function confirmPendingQuickStatus() {
    if (!pendingQuickConfirm) return;
    const { code, prefilledClientName } = pendingQuickConfirm;
    setPendingQuickConfirm(null);
    changeStatus(code, prefilledClientName, true, true);
  }

  /** 흐름 재확인 팝업에서 "네, 맞아요"를 눌렀을 때 — 이동중 없이 건너뛴 게 맞다고 확인했으니 그대로 진행한다. */
  function confirmPendingSequence() {
    if (!pendingSequenceConfirm) return;
    const { code, prefilledClientName } = pendingSequenceConfirm;
    setPendingSequenceConfirm(null);
    changeStatus(code, prefilledClientName, false, true);
  }

  /** 흐름 재확인 팝업에서 "아니요, 다시 볼게요"를 눌렀을 때 — 아무것도 등록하지 않고 닫는다. */
  function cancelPendingSequence() {
    setPendingSequenceConfirm(null);
  }

  /** 즉시등록 확인 팝업에서 "아니요"를 누르거나 잘못 눌렀을 때 — 아무것도 등록하지 않고 닫는다. */
  function cancelPendingQuickStatus() {
    setPendingQuickConfirm(null);
  }

  async function handleDetailFormSubmit() {
    if (detailSubmitting) return;
    setDetailSubmitting(true);
    try {
      await submitDetailForm();
    } finally {
      setDetailSubmitting(false);
    }
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
    // 2026-09-14: 영업조직(isSimplifiedMeetingForm)은 고객사미팅 화면에서 작업내용·작업위치
    // 입력칸을 아예 없앴으므로, 여기서 안전한 기본값을 대신 채워 백엔드 필수값과 기존
    // 최소글자수 검증을 통과시킨다 — 사용자에게는 보이지 않지만 실제로는 값이 필요하다.
    const effectiveWorkDetail = isSimplifiedMeetingForm ? (workDetail.trim() || `${workType} 미팅 진행`) : workDetail;
    const effectiveSiteType = isSimplifiedMeetingForm ? (siteType || 'ONSITE') : siteType;
    if (effectiveWorkDetail.trim().length < minDetailLen) return;
    // 본사근무는 관련 프로젝트/고객사 자유서술이 필수, 고객사미팅/고객사작업은 등록된 고객사
    // 목록에서 고른 이름이 필수다(빈칸으로 저장되면 리포트에서 통째로 누락됨 — 2026-09-02).
    if ((code === 'HQ_WORKING' || LOCATION_CHECK_STATUSES.has(code)) && !clientName.trim()) return;
    if (!SIMPLIFIED_EFFORT_STATUSES.has(code) && !workReason.trim()) return;
    // 작업위치(원격/현장, 필수) · 작업인원(선택) · 진행률/차수(선택, 야간작업만) — 야간작업/고객사미팅/고객사작업만 해당.
    if (SITE_DETAIL_STATUSES.has(code) && !effectiveSiteType) return;
    // 고객사작업/야간작업/주말작업은 완료시간까지 필수다(2026-09-14 요청) — 버튼 disabled와 동일.
    // 단, 2026-09-15부터 "진행중" 체크박스를 명시적으로 켠 경우에는 예외로 허용한다.
    if (END_TIME_REQUIRED_STATUSES.has(code) && !workEnd && !stillInProgress) return;
    const siteDetailSuffix = SITE_DETAIL_STATUSES.has(code)
      ? ` | 작업위치: ${effectiveSiteType === 'ONSITE' ? '현장' : '원격'}${personnel ? ` | 작업인원: ${personnel}` : ''}`
      : '';
    const reasonSuffix = workReason.trim() ? ` | 목적: ${workReason}` : '';
    const note = (code === 'HQ_WORKING'
      ? `유형: ${workType} | 관련 프로젝트/고객사: ${clientName || '-'} | 수행업무: ${effectiveWorkDetail}`
      : code === 'CLIENT_MEETING'
        ? `미팅목적: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 미팅주제: ${effectiveWorkDetail}${reasonSuffix}`
        : `유형: ${workType} | 고객사: ${clientName || '-'}${projectName ? ` | 프로젝트: ${projectName}` : ''} | 시작 ${workStart}${workEnd ? ` | 완료 ${workEnd}` : ' | 진행중'} | 내용: ${effectiveWorkDetail}${reasonSuffix}`) + siteDetailSuffix;
    const body: Record<string, unknown> = { status: code, note };
    if (SITE_DETAIL_STATUSES.has(code)) {
      body.siteType = effectiveSiteType;
    }
    if (DETAIL_FORM_STATUSES.has(code)) {
      body.effort = {
        clientName,
        // 목록에서 정확히 고른 고객사면 id도 같이 보낸다 — 같은 문자열을 포함하는 지점이 여러
        // 곳(본점/세양센터 등)이어도 서버가 정확히 이 지점만 대조하도록(2026-09-08).
        clientId: clientId || undefined,
        projectName,
        projectId: projectId || undefined,
        taskId: taskId || undefined,
        workType,
        startTime: workStart,
        endTime: workEnd || undefined,
        // 완료시간을 비워둔 게 실수가 아니라 "진행중" 체크박스를 켜서 의도적으로 비운 것임을
        // 서버가 구분할 수 있게 같이 보낸다(END_TIME_REQUIRED_STATUSES 예외 판단용, 2026-09-15).
        inProgress: !workEnd && stillInProgress ? true : undefined,
        description: workReason.trim() ? `${workDetail} (목적: ${workReason})` : workDetail,
        ...(SITE_DETAIL_STATUSES.has(code) ? { personnel: personnel || undefined } : {}),
      };
    }
    // 고객사미팅/고객사작업은 등록 순간 위치를 확인해서 등록된 고객사 위치와 대조한다(동의한 경우에만).
    // 위치 확보 실패 사유(locationStatus)까지 같이 보내야 서버가 "오늘 첫 실패는 봐준다" 판단을 할 수 있다.
    // 2026-09-19: 야간작업/주말작업은 고객사를 실제로 골랐고(내부업무면 clientName이 비어있음) 현장
    // (ONSITE)으로 등록한 경우에만 시도한다 — 원격지원/내부업무까지 매번 GPS 권한을 물어보면
    // 번거로우니, 서버가 실제로 대조를 시도하는 조건(effort.clientName && siteType!=='REMOTE')과
    // 똑같이 맞춘다(backend attendance.routes.ts 참고).
    // 2026-09-20: 재택(REMOTE)은 EFFORT_CONTINUATION_STATUSES_FRONT에 포함돼 있어서, 시작만 등록한
    // 뒤 나중에 이 상세폼으로 완료시간 등을 채워 다시 제출하면 같은 StatusChangeLog 행을 그대로
    // 갱신한다(새로 만들지 않음) — 이때 여기서 위치를 다시 안 보내면 서버가 처음에 캡처해뒀던
    // locationCaptureStatus='OK'를 null로 덮어써버리는 문제가 생긴다("GPS 캡처만 필수화" 정책으로
    // 재택도 이제 캡처상태가 실제로 저장되기 시작해서 새로 드러난 위험). 본사근무와 동일하게
    // 항상 재측정해서 이 문제를 원천적으로 막는다.
    const needsLocationCheck =
      LOCATION_CHECK_STATUSES.has(code) ||
      code === 'HQ_WORKING' ||
      code === 'REMOTE' ||
      (LOCATION_CHECK_ELIGIBLE_STATUSES.has(code) && Boolean(clientName.trim()) && siteType === 'ONSITE');
    // 본사근무도 고객사작업/미팅과 동일하게 위치 확보 실패 사유까지 같이 보낸다("오늘 첫 실패는 봐준다" 판단용).
    const detailFormLocationMeta: { accuracy: number | null; jumpDetected: boolean } = { accuracy: null, jumpDetected: false };
    const refreshDetailFormLocation = async () => {
      const { status: locStatus, coords, accuracyMeters, jumpDetected } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
      body.locationStatus = locStatus;
      detailFormLocationMeta.accuracy = accuracyMeters;
      detailFormLocationMeta.jumpDetected = jumpDetected;
      if (coords) {
        body.location = coords;
        // 2026-09-16: 오차범위를 서버로 함께 보낸다(위치 미확인/불일치 개선 1순위, HQ_WORKING과
        // 동일한 이유 — refreshHqQuickLocation 주석 참고).
        // 2026-10-01 수정: 서버가 읽는 필드명(accuracyMeters)으로 맞춘다 — refreshHqQuickLocation
        // 주석 참고(기존 locationAccuracyMeters라는 이름으로는 서버가 이 값을 받지 못했다).
        body.accuracyMeters = accuracyMeters ?? undefined;
        // 본사근무만 역지오코딩 주소를 같이 보낸다 — 고객사미팅/작업은 등록된 고객사 좌표와
        // 직접 대조하므로 주소 매칭이 필요 없다(불필요한 카카오맵 호출도 줄인다).
        body.locationAddress = code === 'HQ_WORKING' ? (await reverseGeocode(coords.lat, coords.lng)) ?? undefined : undefined;
      } else {
        delete body.location;
        delete body.locationAddress;
        delete body.accuracyMeters;
      }
    };
    if (needsLocationCheck) {
      await refreshDetailFormLocation();
      // 이상치(순간이동) 감지 시 등록 자체를 막고 재측정을 유도한다(2026-09 요청 — 등록 차단).
      if (detailFormLocationMeta.jumpDetected) {
        setMessage(LOCATION_JUMP_WARNING);
        setMessageIsError(true);
        return;
      }
    }

    if (code === 'NIGHT_WORK') {
      // 야간작업 완료 등록은 응답의 대체휴무 권고 여부를 바로 확인해야 해서 run()을 안 거치고 직접 호출한다.
      setMessage(null);
      setMessageIsError(false);
      try {
        const res = await withMismatchConfirm(code, body, () =>
          apiFetch<{ statusLog: unknown; nightWork: { altDayOffRecommended?: boolean } | null }>(
            '/attendance/status', { method: 'POST', body: JSON.stringify(body) }
          )
        );
        setMessage(`상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊`);
        refreshMyStatus();
        if (res.nightWork?.altDayOffRecommended) setShowAltDayOffPrompt(true);
      } catch (err) {
        // 위치확인 모달을 띄운 경우(silent)는 조용히 넘어간다 — run()을 안 거치는 이 경로에도
        // withMismatchConfirm과 동일한 규칙을 적용한다.
        if (!(err as Error & { silent?: boolean } | undefined)?.silent) {
          setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
          setMessageIsError(true);
        }
      }
      setDetailStatus(null);
      return;
    }

    run(
      () =>
        withMismatchConfirm(code, body, () =>
          attemptWithLocationRetry(
            () => apiFetch<{ locationMismatchException?: boolean }>('/attendance/status', { method: 'POST', body: JSON.stringify(body) }),
            needsLocationCheck ? refreshDetailFormLocation : undefined
          )
        ),
      `상태가 '${STATUS_META[code].label}'(으)로 변경되었습니다. 😊${
        isLowAccuracy(detailFormLocationMeta.accuracy) ? ` (${accuracyWarningLabel(detailFormLocationMeta.accuracy)})` : ''
      }`,
      // 2026-09-08: 위치가 등록된 고객사와 달라도(예: 실내 GPS 오차) 등록 자체는 막지 않고 예외로
      // 통과시키되, 직원이 상황을 알 수 있도록 안내 문구로 성공 메시지를 덮어쓴다 — 관리자 화면
      // "위치 불일치" 배지로도 남아 사후 확인이 가능하다.
      (data) => {
        if ((data as { locationMismatchException?: boolean } | undefined)?.locationMismatchException) {
          const sentLocation = body.location as { lat: number; lng: number } | undefined;
          if (sentLocation) {
            // 2026-10-01 추가: 안내만 하고 끝내지 않고, 그 자리에서 카카오맵으로 본인 위치를 다시
            // 확인/보정해 등록할 수 있게 제안한다(resubmitWithCorrectedLocation 참고).
            setMessage('⚠ 위치가 등록된 고객사와 달라 예외로 등록됐어요 — 아래에서 지도로 실제 위치를 확인하면 바로 정정할 수 있어요.');
            setMessageIsError(false);
            setLocationCorrection({ code, body, lat: sentLocation.lat, lng: sentLocation.lng });
          } else {
            setMessage('⚠ 위치가 등록된 고객사와 달라 예외로 등록됐어요 — 관리자 확인이 필요할 수 있어요.');
            setMessageIsError(false);
          }
        }
      }
    );
    setDetailStatus(null);
  }

  /**
   * 2026-10-01 추가: 위치 불일치로 예외 등록된 직후, 직원이 카카오맵에서 확인/보정한 좌표로
   * 같은 상태를 다시 제출한다. 같은 날 같은 상태 재제출은 서버가 기존 StatusChangeLog를 새로
   * 만들지 않고 그대로 갱신하므로(willUpdateExistingEffort/willResumeNightWork), 보정에 성공하면
   * (등록된 고객사 좌표와의 거리가 반경 이내면) 그 기록의 locationMatch가 true로 바뀌어 관리자
   * 상황판의 불일치 표시도 함께 해소된다(dashboard.routes.ts의 "당일 한 번이라도 성공하면
   * 해소" 로직) — 새 엔드포인트나 별도 예외 경로를 만들지 않고 기존 /attendance/status 제출
   * 경로와 동일한 위치대조 로직을 그대로 재사용한다(보안/검증 로직을 약화하지 않기 위함).
   * 지도에서 직접 클릭/확정한 좌표는 GPS 오차가 아니라 본인이 확정한 지점이므로, 오차범위
   * 봐주기(accuracyAllowanceMeters)는 적용하지 않고 accuracyMeters를 0으로 보낸다.
   */
  // 서버(attendance.routes.ts)의 MAX_ACCURACY_ALLOWANCE_METERS와 반드시 같은 값을 유지해야 한다 —
  // 여기서는 네트워크 왕복 없이 바로 안내하기 위한 선검증일 뿐이고, 실제 허용 여부는 항상 서버가
  // 최종 판단한다(위조 방지를 위해 서버는 이 클라이언트 값을 신뢰하지 않고 자체 기록과 비교한다).
  const MAX_SELF_CORRECTION_METERS = 1000;

  async function resubmitWithCorrectedLocation(lat: number, lng: number) {
    if (!locationCorrection || locationCorrectionBusy) return;
    const { code, body } = locationCorrection;
    setLocationCorrectionError(null);
    const distanceFromGps = distanceMeters(locationCorrection.lat, locationCorrection.lng, lat, lng);
    if (distanceFromGps > MAX_SELF_CORRECTION_METERS) {
      setLocationCorrectionError(
        `처음 측정된 내 위치에서 약 ${Math.round(distanceFromGps)}m 떨어져 있어요(최대 ${MAX_SELF_CORRECTION_METERS}m까지만 보정 가능). 실제 계신 곳 근처를 다시 찍어주세요.`
      );
      return;
    }
    setLocationCorrectionBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const correctedBody: Record<string, unknown> = { ...body, location: { lat, lng }, accuracyMeters: 0 };
      const data = await apiFetch<{ locationMismatchException?: boolean }>('/attendance/status', {
        method: 'POST',
        body: JSON.stringify(correctedBody),
      });
      setLocationCorrection(null);
      if (data?.locationMismatchException) {
        setMessage('⚠ 다시 확인한 위치도 등록된 고객사 위치와 거리가 있어요 — 관리자 확인이 필요할 수 있어요.');
        setMessageIsError(false);
      } else {
        setMessage(`✅ 위치를 다시 확인해서 '${STATUS_META[code]?.label ?? code}' 정상 등록으로 반영했어요.`);
        setMessageIsError(false);
      }
      refreshMyStatus();
    } catch (err) {
      // 2026-10-01: 서버가 "정정 허용범위 초과"(LOCATION_CORRECTION_TOO_FAR — 실제 측정된 GPS
      // 지점에서 너무 멀리 떨어진 곳을 지도에서 찍은 경우, attendance.routes.ts 참고)로 거부하면,
      // 이 지도 모달은 전체화면이라 바깥 메시지 배너가 안 보이므로 모달을 닫지 않고 그 안에
      // 사유를 보여줘서 실제 위치 근처에서 다시 찍어보도록 유도한다.
      const errMessage = err instanceof Error ? err.message : '위치 재등록에 실패했습니다.';
      setLocationCorrectionError(errMessage);
      setMessage(errMessage);
      setMessageIsError(true);
    } finally {
      setLocationCorrectionBusy(false);
    }
  }

  /**
   * 2026-10-02 추가(위치 불일치 하드블록 재도입과 함께): 최초 등록이 LOCATION_MISMATCH_BLOCKED로
   * 막혀서 뜬 모달(locationCorrection.blocked===true)에서 "여기가 맞습니다"를 누르면, 막혔던 그
   * 요청을 selfConfirmMismatch:true + confirmedLocation(지금 확정/보정한 좌표)을 더해 그대로
   * 재시도한다 — body.location(이번에 실제로 측정된 원본 GPS)은 그대로 둔다(서버가 그 원본과
   * confirmedLocation의 거리를 재서 스푸핑을 막으므로, resubmitWithCorrectedLocation처럼
   * location 자체를 덮어쓰면 안 된다).
   */
  async function retryBlockedStatusWithSelfConfirm(lat: number, lng: number) {
    if (!locationCorrection || locationCorrectionBusy) return;
    const { code, body } = locationCorrection;
    setLocationCorrectionError(null);
    setLocationCorrectionBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const retryBody: Record<string, unknown> = { ...body, selfConfirmMismatch: true, confirmedLocation: { lat, lng } };
      await apiFetch<{ locationMismatchException?: boolean }>('/attendance/status', {
        method: 'POST',
        body: JSON.stringify(retryBody),
      });
      setLocationCorrection(null);
      setMessage(
        `✅ 실제 위치를 확인해서 '${STATUS_META[code]?.label ?? code}'(으)로 등록했어요. 등록된 위치와는 달라 관리자 화면에 "위치 불일치"로 표시돼요.`
      );
      setMessageIsError(false);
      refreshMyStatus();
    } catch (err) {
      // 서버가 "정정 허용범위 초과"(LOCATION_CORRECTION_TOO_FAR — 확정/클릭한 좌표가 이번에 실제로
      // 측정된 GPS 지점에서 너무 멀 때)로 거부하면, 모달을 닫지 않고 그 안에 사유를 보여줘서 실제
      // 위치 근처에서 다시 찍어보도록 유도한다(resubmitWithCorrectedLocation과 동일한 UX).
      const errMessage = err instanceof Error ? err.message : '위치 재등록에 실패했습니다.';
      setLocationCorrectionError(errMessage);
      setMessage(errMessage);
      setMessageIsError(true);
    } finally {
      setLocationCorrectionBusy(false);
    }
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  // 2026-09-18: 최근에 등록한 고객사(recentClients, 본인 것만 최신순) 중 지금도 목록에 있는
  // 것만 골라, 검색창 위 원탭 칩과 목록 맨 위 "최근 등록" 구간에 함께 쓴다.
  const recentClientOptions = useMemo(() => {
    const byId = new Map(clientOptions.map((c) => [c.id, c]));
    return recentClients.map((c) => byId.get(c.id)).filter((c): c is typeof clientOptions[number] => Boolean(c));
  }, [clientOptions, recentClients]);

  // 고객사미팅/고객사작업 검색창에 입력한 글자로 등록된 고객사 목록을 걸러준다(2026-09-02).
  // 2026-09-04: 검색어가 없을 때 20개로 잘라서 보여주던 게 "고객사 목록이 일부만 나온다"는
  // 문제였다 — 목록 영역이 이미 스크롤(max-height 220px, overflow-y auto) 처리돼 있어서 자를
  // 이유가 없었다. 이제 전체를 보여주고, 목록이 너무 길면 검색으로 좁히면 된다.
  // 2026-09-18: 검색어가 없을 때(=목록을 그냥 훑어보는 상황)는 최근 등록한 고객사를 이 목록에서
  // 빼둔다 — 위에서 "최근 등록" 구간으로 따로 먼저 보여주고, 그 아래에 이 목록(전체, 가나다순)을
  // 이어붙이는 방식으로 화면에서 중복 없이 표시한다(렌더링 부분 참고).
  const filteredClientOptions = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) {
      if (recentClientOptions.length === 0) return clientOptions;
      const recentIds = new Set(recentClientOptions.map((c) => c.id));
      return clientOptions.filter((c) => !recentIds.has(c.id));
    }
    return clientOptions.filter((c) => c.name.toLowerCase().includes(q));
  }, [clientOptions, clientQuery, recentClientOptions]);
  // 입력한 글자가 등록된 고객사명과 완전히 같으면(대소문자 무관) "새로 등록" 버튼을 안 보여준다 —
  // 이미 있는 고객사를 실수로 중복 등록하는 걸 막기 위함.
  const exactClientMatch = useMemo(
    () => clientOptions.some((c) => c.name.toLowerCase() === clientQuery.trim().toLowerCase()),
    [clientOptions, clientQuery]
  );

  /** 검색 목록/최근 고객사 칩 어디서 골랐든 동일하게 선택 상태로 확정한다. */
  function selectClient(c: { id: string; name: string }) {
    setClientName(c.name);
    setClientId(c.id);
    setClientQuery(c.name);
    setClientPickerOpen(false);
  }

  /** 목록에 없는 새 고객사 이름을 눌렀을 때 — 바로 등록하지 않고 위치 선택 지도를 띄운다
   * (2026-09-19: 위치 없이 이름만으로 등록되던 기존 방식이 "위치 미확인" 누적의 큰 원인이었음). */
  function addNewClientAndSelect() {
    const name = clientQuery.trim();
    if (!name || addingClientBusy) return;
    setClientLocationPicker({ name });
  }

  /** 지도에서 위치를 확정한 뒤 실제로 고객사를 생성하고 바로 선택 상태로 만든다. */
  async function confirmNewClientWithLocation(lat: number, lng: number, address?: string) {
    const name = clientLocationPicker?.name;
    if (!name || addingClientBusy) return;
    setAddingClientBusy(true);
    try {
      const created = await apiFetch<{ id: string; name: string }>('/attendance/clients', {
        method: 'POST',
        body: JSON.stringify({ name, latitude: lat, longitude: lng, ...(address ? { address } : {}) }),
      });
      setClientOptions((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created].sort((a, b) => a.name.localeCompare(b.name))));
      setClientName(created.name);
      setClientId(created.id);
      setClientQuery(created.name);
      setClientPickerOpen(false);
      setClientLocationPicker(null);
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
          {/* ESD 2.0 (2026-10-01 추가, 사용자 요청사항 5): 직원 본인이 자신의 프로젝트 성과 근거를
              직접 확인할 수 있는 화면으로 연결한다 — 관리자 전용이 아니라 모든 직원에게 보인다. */}
          <button
            className="secondary"
            style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }}
            onClick={() => router.push('/my-performance')}
          >
            내 성과
          </button>
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

      {showIosInstallPrompt && (
        // 2026-09-04: 아이폰 사파리는 홈 화면에 추가한 앱에서만 알림이 되므로(애플 정책), 여기서는
        // 알림을 "켜는" 버튼 대신 설치 방법만 안내한다 — 버튼을 눌러도 실패할 게 뻔한데 누르게
        // 하는 건 의미가 없다.
        <div className="card col-full notice-tint-blue">
          🍎 아이폰에서 출근/퇴근 알림을 받으시려면, 먼저 하단 공유 버튼(⬆️) → <strong>&quot;홈 화면에 추가&quot;</strong>로 앱을 설치하신 뒤, 그 아이콘으로 다시 열어서 알림을 켜주세요.
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={dismissIosInstallPrompt}>
              알겠어요
            </button>
          </div>
        </div>
      )}

      {pendingQuickConfirm && (
        // 2026-09-09: 화면 아래쪽 아이콘을 눌러도 확인 팝업은 배너 목록 맨 위쪽에 렌더링돼서
        // 스크롤을 안 올리면 안 보이던 문제 — 화면 하단에 고정된 시트로 띄워 항상 바로 보이게 한다.
        // 2026-09-16: "가방/주머니 속에서 아이콘이 계속 잘못 눌린다"는 요청으로, 이 팝업의 확정
        // 버튼을 탭 한 번짜리 버튼 대신 밀어서 확정하는 슬라이더(SlideToConfirm)로 바꿨다 — 뜬 직후
        // 잠깐은 밀어도 반응하지 않고, 끝까지 밀어야만 확정되므로 스치는 터치로는 확정되지 않는다.
        <div className="quick-confirm-backdrop" onClick={cancelPendingQuickStatus}>
          <div className="card notice-tint-blue quick-confirm-sheet" onClick={(e) => e.stopPropagation()}>
            {STATUS_META[pendingQuickConfirm.code].icon} '{STATUS_META[pendingQuickConfirm.code].label}'(으)로 확정합니까?
            <div style={{ marginTop: 10 }}>
              <SlideToConfirm onConfirm={confirmPendingQuickStatus} label="밀어서 확정" />
            </div>
            <button className="secondary" style={{ width: 'auto', margin: '8px 0 0' }} onClick={cancelPendingQuickStatus}>
              아니요, 취소할게요
            </button>
          </div>
        </div>
      )}

      {pendingSequenceConfirm && (
        // 2026-09-14: 본사근무/고객사상주/고객사작업/고객사미팅처럼 물리적으로 다른 장소인 상태
        // 사이를 "이동중" 없이 곧장 건너뛰면, 실수로 잘못 누른 건 아닌지 한 번 되물어본다.
        <div className="quick-confirm-backdrop" onClick={cancelPendingSequence}>
          <div className="card notice-tint-blue quick-confirm-sheet" onClick={(e) => e.stopPropagation()}>
            🚦 &apos;{pendingSequenceConfirm.fromLabel}&apos;에서 &apos;이동중&apos; 없이 바로 &apos;{pendingSequenceConfirm.toLabel}&apos;(으)로 등록하시려고 해요. 실제로 이동하신 게 맞나요?
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button style={{ width: 'auto', margin: 0 }} onClick={confirmPendingSequence}>
                네, 맞아요
              </button>
              <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={cancelPendingSequence}>
                아니요, 다시 볼게요
              </button>
            </div>
          </div>
        </div>
      )}

      {showCorrectionModal && (
        <div className="quick-confirm-backdrop" onClick={closeCorrectionModal}>
          <div className="card notice-tint-blue quick-confirm-sheet" onClick={(e) => e.stopPropagation()}>
            ✏️ 상태 정정
            <div className="board-empty" style={{ marginTop: 4, marginBottom: 0 }}>
              오늘 상태를 잘못 등록하셨다면(예: 휴가인데 본사출근을 눌렀어요) 여기서 바로 고칠 수 있어요. 사유는 기록에 남아요.
            </div>

            <label style={{ marginTop: 10, display: 'block' }}>
              바꿀 상태
              <select
                value={correctionStatus}
                onChange={(e) => setCorrectionStatus(e.target.value)}
                style={{ marginTop: 4 }}
              >
                {visibleStatusOrder.map((code) => (
                  <option key={code} value={code}>
                    {STATUS_META[code].icon} {STATUS_META[code].label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ marginTop: 10, display: 'block' }}>
              정정 사유 (필수)
              <textarea
                className="detail-textarea"
                rows={2}
                style={{ marginTop: 4 }}
                placeholder="예: 휴가인데 본사출근을 잘못 눌러서 정정합니다."
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                maxLength={200}
                autoFocus
              />
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                style={{ width: 'auto', margin: 0 }}
                disabled={submittingCorrection || !correctionReason.trim()}
                onClick={submitCorrection}
              >
                {submittingCorrection ? '정정 중...' : '정정 확정'}
              </button>
              <button
                className="secondary"
                style={{ width: 'auto', margin: 0 }}
                disabled={submittingCorrection}
                onClick={closeCorrectionModal}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {arrivedClient && (
        <div className="card col-full notice-tint-blue">
          🚗 <strong>{arrivedClient}</strong>에 도착하신 것 같아요! 어떤 걸로 등록할까요?
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {/* GPS로 실제 이동이 이미 확인된 도착감지 흐름이라 이동중 재확인 팝업은 건너뛴다. */}
            <button style={{ width: 'auto', margin: 0 }} onClick={() => { const c = arrivedClient; setArrivedClient(null); changeStatus('CLIENT_WORK', c, false, true); }}>
              🛠️ 고객사작업
            </button>
            <button style={{ width: 'auto', margin: 0 }} onClick={() => { const c = arrivedClient; setArrivedClient(null); changeStatus('CLIENT_MEETING', c, false, true); }}>
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
                changeStatus('ALT_DAY_OFF', undefined, true);
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

      {showNightWorkTransitionPrompt && (
        <div className="card col-full notice-tint-orange">
          🌙 정규 근무시간({regularWorkEndHour}시)이 지났어요. 계속 근무하실 계획이면, 지금 퇴근으로
          오늘 정규 근무를 마감한 뒤 야간작업으로 이어서 등록해주세요 — 그래야 5분마다 오는 퇴근 알림도 멈춰요.
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              style={{ width: 'auto', margin: 0 }}
              onClick={() => {
                setClockOutThenNightWork(true);
                setShowClockOutConfirm(true);
              }}
            >
              🏁 퇴근하고 야간작업 등록하기
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setNightWorkPromptDismissed(true)}>
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
                // GPS로 실제 이동이 이미 확인된 도착감지 흐름이라 이동중 재확인 팝업은 건너뛴다.
                changeStatus('HQ_WORKING', undefined, true, true);
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
          {departureNeedsReason && (
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                ⏱️ 아직 최소 근무시간 전이에요 — 조기퇴근 사유를 입력해주세요
              </label>
              <input
                type="text"
                value={departureEarlyLeaveReason}
                onChange={(e) => setDepartureEarlyLeaveReason(e.target.value)}
                placeholder="예: 병원 진료로 조기퇴근"
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8 }}
              />
            </div>
          )}
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

      {effortDepartureNotice && (
        <div className="card col-full notice-tint-orange">
          🚚 고객사작업 위치에서 30분 이상 벗어난 것으로 감지되어 <strong>{fmtClock(effortDepartureNotice.estimatedAt)}</strong>에 작업을 마치신 걸로 자동 등록하고 &apos;이동중&apos;으로 전환했어요.
          <div className="board-empty" style={{ marginTop: 4, marginBottom: 0 }}>
            아직 그 고객사에서 작업중이셨다면 사유를 입력해서 바로잡아주세요.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={openCorrectionFromEffortNotice}>
              ✏️ 잘못됐어요 — 정정하기
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={dismissEffortDepartureNotice}>
              확인했어요
            </button>
          </div>
        </div>
      )}

      {adminMessages.map((m) => (
        <div className="card col-full notice-tint-blue" key={m.id}>
          📨 <strong>{m.sentByName}</strong>님이 보낸 메시지: {m.message}
          <div style={{ marginTop: 8 }}>
            <input
              type="text"
              value={replyDrafts[m.id] ?? ''}
              onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
              placeholder="답장을 입력하세요(선택)"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              style={{ width: 'auto', margin: 0 }}
              disabled={!replyDrafts[m.id]?.trim() || replySending[m.id]}
              onClick={() => sendReplyToMessage(m.id)}
            >
              {replySending[m.id] ? '보내는 중...' : '답장 보내기'}
            </button>
            <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => dismissAdminMessage(m.id)}>
              확인했어요
            </button>
          </div>
        </div>
      ))}

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
              disabled={Boolean(myStatus?.record?.clockInAt) || clockInSubmitting}
              onClick={async () => {
                if (clockInSubmitting) return;
                setClockInSubmitting(true);
                setMessage(null);
                setMessageIsError(false);
                try {
                  const clockInBody: Record<string, unknown> = {};
                  const clockInLocationMeta: { accuracy: number | null; jumpDetected: boolean } = { accuracy: null, jumpDetected: false };
                  const refreshClockInLocation = async () => {
                    const { status: locStatus, coords, accuracyMeters, jumpDetected } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
                    clockInBody.locationStatus = locStatus;
                    clockInLocationMeta.accuracy = accuracyMeters;
                    clockInLocationMeta.jumpDetected = jumpDetected;
                    if (coords) {
                      clockInBody.location = coords;
                      // 2026-09-16: 오차범위를 서버로 함께 보낸다(위치 미확인/불일치 개선 1순위).
                      // 2026-10-01 수정: 서버가 읽는 필드명(accuracyMeters)으로 맞춘다 —
                      // refreshHqQuickLocation 주석 참고.
                      clockInBody.accuracyMeters = accuracyMeters ?? undefined;
                      clockInBody.locationAddress = (await reverseGeocode(coords.lat, coords.lng)) ?? undefined;
                    } else {
                      delete clockInBody.location;
                      delete clockInBody.locationAddress;
                      delete clockInBody.accuracyMeters;
                    }
                  };
                  await refreshClockInLocation();
                  // 이상치(순간이동) 감지 시 등록 자체를 막고 재측정을 유도한다(2026-09 요청 — 등록 차단).
                  if (clockInLocationMeta.jumpDetected) {
                    setMessage(LOCATION_JUMP_WARNING);
                    setMessageIsError(true);
                    return;
                  }
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
                } finally {
                  setClockInSubmitting(false);
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
                onCancel={() => { setShowClockOutConfirm(false); setClockOutThenNightWork(false); }}
                onConfirm={async ({ locationAddress, locationStatus, earlyLeaveReason, dailyWorkLog }) => {
                  // 18시 이후 정규근무분 초과(야간작업 등록 제안) 여부를 응답에서 바로 확인해야 해서
                  // run()을 안 거치고 직접 호출한다(NIGHT_WORK 등록과 같은 이유).
                  // 2026-09-30 수정(Critical): 일일업무일지(1단계 강제 마감) — 예전엔 이 함수가
                  // dailyWorkLog를 구조분해하지 않아, 모달이 필수 입력까지 받아 만든 값이 여기서
                  // 통째로 버려졌다(서버도 그 값을 안 받아서 업무일지가 한 건도 저장되지 않았다).
                  // 그리고 실패 시에는 모달을 닫지 않고 그 안에 사유를 보여준다 — 작성한 일지와
                  // 조기퇴근 사유가 날아가지 않도록 하기 위함이라, 여기서 에러를 삼키지 않고 다시 던진다.
                  setMessage(null);
                  setMessageIsError(false);
                  const viaNightWorkBanner = clockOutThenNightWork;
                  try {
                    const res = await apiFetch<{ lateClockOutSuggestion: { overMinutes: number; suggestedStart: string; suggestedEnd: string } | null }>(
                      '/attendance/clock-out',
                      {
                        method: 'POST',
                        body: JSON.stringify({
                          ...(locationAddress ? { locationAddress } : {}),
                          locationStatus,
                          ...(earlyLeaveReason ? { earlyLeaveReason } : {}),
                          dailyWorkLog,
                        }),
                      }
                    );
                    setMessage(`퇴근 처리되었습니다. ${clockOutGreeting(weather)}`);
                    refreshMyStatus();
                    setNightWorkPromptDismissed(true);
                    if (viaNightWorkBanner) {
                      // "퇴근하고 야간작업 등록하기" 배너로 들어온 경우 — 서버가 계산해준 초과분
                      // 제안(19시 이후에만 내려옴)을 기다리지 않고, 지금 바로 야간작업 상세폼을
                      // 열어 시작시각을 지금으로 채워준다(본인이 명시적으로 이어가겠다고 한 것이므로).
                      openDetailForm('NIGHT_WORK');
                      setWorkStart(nowHHMM());
                    } else if (res.lateClockOutSuggestion) {
                      setLateClockOutSuggestion(res.lateClockOutSuggestion);
                    }
                    setShowClockOutConfirm(false);
                    setClockOutThenNightWork(false);
                  } catch (err) {
                    setMessage(err instanceof Error ? err.message : '오류가 발생했습니다.');
                    setMessageIsError(true);
                    // 모달이 사유를 표시하고 열린 상태로 남도록 그대로 다시 던진다(SlideToConfirm은
                    // false/예외를 받으면 손잡이를 원위치로 되돌린다).
                    throw err;
                  }
                }}
              />
            )}
            {clientLocationPicker && (
              <MapPickerModal
                initialAddress={clientLocationPicker.name}
                onClose={() => setClientLocationPicker(null)}
                onSelect={(lat, lng, address) => confirmNewClientWithLocation(lat, lng, address)}
              />
            )}
            {locationCorrection && (
              <MapPickerModal
                initialCoords={{ lat: locationCorrection.lat, lng: locationCorrection.lng }}
                title="📍 내 위치 확인/정정"
                helpText={
                  locationCorrectionBusy
                    ? '다시 등록하는 중...'
                    : locationCorrection?.blocked
                      // 2026-10-02 추가: 하드블록으로 애초에 등록이 안 된 상태에서 뜨는 안내 —
                      // 2026-10-01 보정 안내와 동일한 원칙(GPS 지점 근처만 인정)을 쓰되, "등록은
                      // 이미 됐다"가 아니라 "아직 등록이 안 됐다"는 점을 명확히 한다.
                      ? '등록된 위치와 거리가 멀어 등록이 막혔어요. 지금 계신 곳의 GPS 위치가 지도에 표시돼요. 위치가 맞으면 그대로 "여기가 맞습니다 · 등록 계속"을 눌러주세요. 실내 등 GPS 오차로 핀이 살짝 어긋났다면, 실제로 지금 계신 곳 근처를 다시 찍어 보정해주세요. (고객사 주소 등 실제로 계시지 않은 곳을 찍으면 정정으로 인정되지 않아요.)'
                      // 2026-10-01: "다른 곳을 찍어도 통과된다"는 오해를 막기 위해, 이건 GPS로 잡힌
                      // 내 위치를 보정하는 용도이지 임의의 장소(예: 고객사 주소)를 찍는 용도가
                      // 아니라는 점을 명시한다 — 실제로 서버도 처음 측정된 GPS 지점에서 너무 먼
                      // 곳은 거부한다(attendance.routes.ts의 LOCATION_CORRECTION_TOO_FAR).
                      : '지금 계신 곳의 GPS 위치가 지도에 표시돼요. 위치가 맞으면 그대로 "이 위치로 다시 등록"을 눌러주세요. 실내 등 GPS 오차로 핀이 살짝 어긋났다면, 실제로 지금 계신 곳 근처를 다시 찍어 보정해주세요. (고객사 주소 등 실제로 계시지 않은 곳을 찍으면 정정으로 인정되지 않아요.)'
                }
                confirmLabel={locationCorrection?.blocked ? '여기가 맞습니다 · 등록 계속' : '이 위치로 다시 등록'}
                errorOverride={locationCorrectionError}
                onClose={() => {
                  if (locationCorrectionBusy) return;
                  setLocationCorrection(null);
                  setLocationCorrectionError(null);
                }}
                onSelect={(lat, lng) =>
                  locationCorrection?.blocked
                    ? retryBlockedStatusWithSelfConfirm(lat, lng)
                    : resubmitWithCorrectedLocation(lat, lng)
                }
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
            <div style={{ marginTop: 10 }}>
              <PilotFeedbackButton />
            </div>
          </div>

          <div className="card">
            <h2>지금 상태 콕! 눌러주세요. 근무기록은 여러분들에게 더 큰 혜택을 드릴 수 있어요.</h2>
            {clockedOut && (
              <div className="board-empty" style={{ marginBottom: 8, color: '#f08c00', fontWeight: 600 }}>
                🔒 퇴근 처리되어 상태를 더 이상 바꿀 수 없습니다 (야간작업은 계속 등록 가능해요). 내일 다시 만나요!
              </div>
            )}
            {clockedOut && myStatus?.record?.clockOutAt && (
              <CancelClockOutCard
                clockOutAt={myStatus.record.clockOutAt}
                latestRequest={cancelClockOutStatus}
                onSubmitted={refreshMyStatus}
              />
            )}
            {isWeekendToday && (
              <div className="board-empty" style={{ marginBottom: 8, color: '#1c7ed6' }}>
                🗓️ 주말이에요 — 오늘은 &quot;주말작업&quot;만 등록할 수 있어요. 평일 상태 아이콘은 월요일에 다시 열려요.
              </div>
            )}
            <div className="status-icon-grid">
              {visibleStatusOrder.map((code) => {
                // 퇴근(낮근무 종료) 후에도 야간작업자는 계속 상태를 등록해야 하니 예외로 둔다.
                // 지난 근무일 퇴근 미해결 건이 있으면(정정 신청 전까지) 야간작업 예외 없이 전부 잠근다 —
                // 오늘 상태를 계속 쌓아가기 전에 어제 문제부터 정리하게 하기 위함.
                // 2026-09-06: 주말(토/일)엔 "주말작업" 하나만 남기고 나머지 상태 아이콘을 전부
                // 잠근다(요청사항) — 서버도 동일한 요일 기준으로 최종 검증하므로(attendance.routes.ts
                // isWeekendKST), 화면 잠금과 실제 등록 가능 여부가 항상 일치한다.
                // 2026-09-14: 관리자 계정이라고 이 잠금들을 건너뛰게 해뒀던 예외를 없앴다 — 관리자도
                // 똑같은 사용자 화면·똑같은 규칙으로 등록하고, 관리 기능이 필요하면 /admin으로 들어간다.
                const isLocked = mustResolvePastCorrection
                  ? true
                  : isWeekendToday
                    ? code !== 'WEEKEND_WORK'
                    // 평일엔 반대로 "주말작업" 아이콘 자체를 잠가서, 눌러도 어차피 서버가 거절할
                    // 상황을 애초에 만들지 않는다.
                    : code === 'WEEKEND_WORK' || (clockedOut && code !== 'NIGHT_WORK');
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
            <button
              style={{
                marginTop: 10,
                marginBottom: 0,
                background: '#fff4e6',
                color: '#c2410c',
                border: '2px solid #f76707',
                fontWeight: 700,
                fontSize: 15,
              }}
              onClick={() => openCorrectionModal()}
            >
              ✏️ 상태를 잘못 등록했어요 — 정정하기
            </button>
          </div>

          {me.assignedClient && (
            <div className="card">
              <h2>고객사 상주 도착체크</h2>
              <button
                onClick={() =>
                  run(async () => {
                    // 2026-09-16: getCurrentLocation() 대신 getCurrentLocationWithStatus()를 써서
                    // 오차범위(accuracyMeters)도 같이 받아 서버로 전송한다 — 본사근무/고객사미팅/
                    // 작업과 동일한 방식으로 위치대조 정확도를 개선한다(위치 미확인/불일치 개선 1순위).
                    const { coords: loc, accuracyMeters } = await getCurrentLocationWithStatus(Boolean(me?.locationConsentGiven));
                    return apiFetch('/resident/checkin', {
                      method: 'POST',
                      body: JSON.stringify(loc ? { location: loc, accuracyMeters: accuracyMeters ?? undefined } : {}),
                    });
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
              <button disabled={!tripDestination.trim() || !tripStart || !tripPurpose.trim() || detailSubmitting} onClick={handleDetailFormSubmit}>
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
              <button disabled={!leaveStart || !leaveEnd || detailSubmitting} onClick={handleDetailFormSubmit}>등록</button>
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
              <button disabled={!leaveStart || detailSubmitting} onClick={handleDetailFormSubmit}>등록</button>
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
              <button disabled={!movingFrom.trim() || !movingTo.trim() || detailSubmitting} onClick={handleDetailFormSubmit}>등록</button>
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
              <label className="field-label">업무내용(무엇을/어떻게)</label>
              <textarea
                className="detail-textarea right-col-textarea"
                rows={3}
                placeholder={detailStatus === 'REMOTE' ? '예: OO상사 방화벽 원격 장애대응 진행' : '예: 서버 정기점검 및 모니터링 대시보드 확인'}
                value={workDetail}
                onChange={(e) => setWorkDetail(e.target.value)}
              />
              {/* 2026-09-22: 최소 글자수(10자) 제약 제거 요청 반영 — 완전히 빈 값만 막는다. */}
              <button disabled={!workDetail.trim() || detailSubmitting} onClick={handleDetailFormSubmit}>등록</button>
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
              {continuedNotice && (
                <p className="hint-box" style={{ background: '#0f2a1f', borderColor: '#2f9e44', color: '#7fd99a' }}>
                  {continuedNotice}
                </p>
              )}
              <label className="field-label">
                {detailStatus === 'HQ_WORKING'
                  ? '고객사/관련 프로젝트 (필수)'
                  : detailStatus === 'REMOTE'
                    ? '지원 고객사'
                    : LOCATION_CHECK_STATUSES.has(detailStatus)
                      ? '고객사명 (필수 — 목록에서 선택)'
                      : ['NIGHT_WORK', 'WEEKEND_WORK'].includes(detailStatus ?? '')
                        ? '고객사명 (목록에서 선택 — 내부 업무면 아래 버튼으로 비워두세요)'
                        : '고객사명'}
              </label>
              {LOCATION_CHECK_ELIGIBLE_STATUSES.has(detailStatus) ? (
                <div className="client-combobox">
                  {/* 2026-09-19: 야간작업/주말작업은 프리세일즈의 사무실 제안작업처럼 고객사가 아예
                      없는 "내부업무"도 정상 케이스라(사용자 피드백), 검색만으로는 "선택 안 함"을
                      표현할 수 없어 이 버튼을 따로 둔다 — 누르면 고객사 없이 그대로 등록된다. */}
                  {['NIGHT_WORK', 'WEEKEND_WORK'].includes(detailStatus ?? '') && (
                    <button
                      type="button"
                      className={`recent-client-chip${!clientName.trim() && !clientQuery.trim() ? ' active' : ''}`}
                      style={{ marginBottom: 8 }}
                      onClick={() => {
                        setClientName('');
                        setClientId('');
                        setClientQuery('');
                        setClientPickerOpen(false);
                      }}
                    >
                      🏢 내부업무(고객사 없음)
                    </button>
                  )}
                  {/* 2026-09-18: "최근 등록한 고객사가 매번 위로 오면 좋겠다" 요청으로 검색창 위에
                      칩을 항상 띄웠었는데, 2026-09-19 피드백 — "포티넷 칩이 뭔지 헷갈린다, 검색창을
                      누르기 전엔 숨겨뒀다가 누르면 드롭다운으로 보여달라"는 요청으로 늘 보이던 칩을
                      없애고, 아래 드롭다운(clientPickerOpen)의 "최근 방문 고객사" 구간으로만 보여
                      준다 — 엔지니어/영업이 보통 10~15곳을 다닌다고 해서 개수도 15로 늘렸다
                      (백엔드 RECENT_CLIENT_LIMIT). */}
                  <input
                    value={clientQuery}
                    onChange={(e) => {
                      setClientQuery(e.target.value);
                      setClientName(''); // 목록에서 다시 고르거나 새로 등록하기 전까지는 미확정 상태로 둔다.
                      setClientId('');
                      setClientPickerOpen(true);
                    }}
                    onFocus={() => setClientPickerOpen(true)}
                    onBlur={() => setTimeout(() => setClientPickerOpen(false), 150)}
                    placeholder="눌러서 최근 방문 고객사 보기 · 검색은 이름 입력 (예: OO상사)"
                  />
                  {/* 2026-09-04: position:absolute로 입력창 아래 띄우던 걸 일반 흐름으로 바꿨다 —
                      모바일에서 화면키보드가 뜨면 절대좌표로 겹쳐 그려지는 목록이 키보드에 가려져
                      "목록이 안 보여요" 문제가 있었다. 그냥 아래로 밀어내는 방식이 항상 보인다. */}
                  {clientPickerOpen && (
                    <div className="client-combobox-list">
                      {clientOptionsError && (
                        <div className="client-combobox-empty">⚠ 고객사 목록을 불러오지 못했습니다. 인터넷 연결을 확인하고 화면을 새로고침 해주세요.</div>
                      )}
                      {!clientOptionsError && filteredClientOptions.length === 0 && recentClientOptions.length === 0 && !clientQuery.trim() && (
                        <div className="client-combobox-empty">등록된 고객사가 없습니다. 아래에 이름을 입력해 새로 등록해주세요.</div>
                      )}
                      {!clientQuery.trim() && recentClientOptions.length > 0 && (
                        <>
                          <div className="client-combobox-section-label">🕘 최근 방문 고객사</div>
                          {recentClientOptions.map((c) => (
                            <button
                              type="button"
                              key={`recent-${c.id}`}
                              className="client-combobox-item"
                              onMouseDown={(e) => {
                                e.preventDefault(); // onBlur보다 먼저 선택이 처리되게(안 그러면 목록이 먼저 닫혀버림).
                                selectClient(c);
                              }}
                            >
                              <span className="client-combobox-name">{c.name}</span>
                            </button>
                          ))}
                          {filteredClientOptions.length > 0 && <div className="client-combobox-section-label">전체 고객사</div>}
                        </>
                      )}
                      {filteredClientOptions.map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          className="client-combobox-item"
                          onMouseDown={(e) => {
                            e.preventDefault(); // onBlur보다 먼저 선택이 처리되게(안 그러면 목록이 먼저 닫혀버림).
                            selectClient(c);
                          }}
                        >
                          <span className="client-combobox-name">{c.name}</span>
                          {c.address && <span className="client-combobox-address">{c.address}</span>}
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
                    <p className="hint-box" style={{ marginTop: 4 }}>
                      {['NIGHT_WORK', 'WEEKEND_WORK'].includes(detailStatus ?? '')
                        ? '* 목록에서 고객사를 선택하거나, 없으면 새로 등록해주세요 — 고객사가 없는 내부업무면 위 "내부업무" 버튼을 눌러주세요.'
                        : '* 목록에서 고객사를 선택하거나, 목록에 없으면 새로 등록해주세요.'}
                    </p>
                  )}
                </div>
              ) : (
                <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="예: OO상사" />
              )}

              {/* 2026-09-14: "입력할 게 너무 많다"는 의견 — 고객사미팅/고객사작업은 필수가 아닌
                  항목(프로젝트명·작업인원, 고객사미팅은 완료시간도 포함)을 기본으로 접어두고,
                  필요할 때만 펼친다. 고객사작업의 완료시간은 이제 필수라 접이 대상에서 뺐다
                  (아래 시작/완료 시간 블록 참고). */}
              {/* 영업조직(isSimplifiedMeetingForm)은 미팅시작·미팅목적·고객사 3항목만 쓰기로 해서
                  이 "선택 항목 펼치기" 토글 자체를 안 보여준다 — 펼쳐봐야 쓸 항목이 없다. */}
              {(detailStatus === 'CLIENT_MEETING' || detailStatus === 'CLIENT_WORK') && !isSimplifiedMeetingForm && (
                <button
                  type="button"
                  className="secondary"
                  style={{ width: 'auto', margin: '0 0 10px', fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setShowMoreFields((v) => !v)}
                >
                  {showMoreFields
                    ? '▲ 선택 항목 접기'
                    : detailStatus === 'CLIENT_MEETING'
                      ? '▾ 프로젝트명 · 완료시간 · 작업인원 입력(선택)'
                      : '▾ 프로젝트명 · 작업인원 입력(선택)'}
                </button>
              )}

              {EFFORT_STATUSES.has(detailStatus) && detailStatus !== 'HQ_WORKING' && showMoreFields && (
                <>
                  <label className="field-label">프로젝트</label>
                  <select
                    className="field-select"
                    value={projectId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setProjectId(nextId);
                      setTaskId('');
                      const p = projectOptions.find((x) => x.id === nextId);
                      if (p) {
                        // 서버가 어차피 projectId 기준으로 정식 명칭을 다시 채워 저장하지만(신뢰 안 함),
                        // 화면에도 바로 보이도록 미리 채워둔다.
                        setProjectName(p.name);
                      }
                    }}
                  >
                    <option value="">미등록 프로젝트 / 자유입력</option>
                    {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                  </select>
                  {!projectId && (
                    <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="예: 백업시스템 구축 2차 (기존 기록 호환용 자유입력)" />
                  )}
                  {selectedProject && selectedProject.tasks.length > 0 && (
                    <>
                      <label className="field-label">Task (선택)</label>
                      <select className="field-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                        <option value="">Task 미지정</option>
                        {selectedProject.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                      </select>
                    </>
                  )}
                </>
              )}

              <label className="field-label">{detailStatus === 'CLIENT_MEETING' ? '미팅목적' : '작업 유형'}</label>
              <select className="field-select" value={workType} onChange={(e) => setWorkType(e.target.value)}>
                {(detailStatus === 'HQ_WORKING' ? HQ_WORK_TYPE_OPTIONS : detailStatus === 'CLIENT_MEETING' ? MEETING_PURPOSE_OPTIONS : WORK_TYPE_OPTIONS).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>

              {detailStatus !== 'HQ_WORKING' && (
                // 고객사미팅만 완료시간이 선택이라 기본으로 접어서 시작시간만 보여준다. 고객사작업/
                // 야간작업/주말작업(END_TIME_REQUIRED_STATUSES)은 완료시간이 필수라 접지 않고
                // 항상 시작~완료를 같이 보여준다(2026-09-14).
                detailStatus === 'CLIENT_MEETING' && !showMoreFields ? (
                  <>
                    <div className="field-label-row">
                      <label className="field-label">미팅시작</label>
                      <button type="button" className="now-fill-button" onClick={() => setWorkStart(nowHHMM())}>🕐 지금</button>
                    </div>
                    <TimeSelectInput value={workStart} onChange={setWorkStart} />
                  </>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div className="field-label-row">
                        <label className="field-label">{detailStatus === 'CLIENT_MEETING' ? '미팅시작' : '작업시작'}</label>
                        <button type="button" className="now-fill-button" onClick={() => setWorkStart(nowHHMM())}>🕐 지금</button>
                      </div>
                      <TimeSelectInput value={workStart} onChange={setWorkStart} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="field-label-row">
                        <label className="field-label">
                          {detailStatus === 'CLIENT_MEETING'
                            ? '미팅완료(선택)'
                            : END_TIME_REQUIRED_STATUSES.has(detailStatus)
                              ? (stillInProgress ? '작업완료 (진행중)' : '작업완료 (필수)')
                              : '작업완료(선택)'}
                        </label>
                        {/* 2026-09-18: "완료시간을 직접 골라야 해서 번거롭다" — 지금 막 끝난 경우가
                            대부분이라, 시/분을 일일이 고르지 않고 현재시각을 바로 채우는 버튼을
                            추가한다. "진행중" 체크박스를 켠 상태에서 이 버튼을 누르면 그건 사실상
                            "지금 끝났다"는 뜻이므로 체크를 자동으로 풀어준다. */}
                        <button
                          type="button"
                          className="now-fill-button"
                          onClick={() => { setWorkEnd(nowHHMM()); setStillInProgress(false); }}
                        >
                          🕐 지금
                        </button>
                      </div>
                      <TimeSelectInput
                        value={workEnd}
                        onChange={setWorkEnd}
                        allowEmpty={!END_TIME_REQUIRED_STATUSES.has(detailStatus) || stillInProgress}
                      />
                      {!END_TIME_REQUIRED_STATUSES.has(detailStatus) && (
                        <p style={{ fontSize: 12, color: '#6b7594', marginTop: 4 }}>* 진행중이면 비워두세요.</p>
                      )}
                      {/* 2026-09-15: 박준영/이보용 피드백 — 고객사작업 등은 완료시간이 필수라서,
                          "언제 끝날지 모르는" 진행중인 작업은 애초에 등록 자체를 못 했다. 이 체크박스를
                          켜면 이번만 완료시간 없이 "진행중" 상태로 등록할 수 있다(작업이 끝나면 그때
                          다시 상태변경으로 완료시간까지 채워 등록해달라고 안내). */}
                      {END_TIME_REQUIRED_STATUSES.has(detailStatus) && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#4b5563', marginTop: 6 }}>
                          <input
                            type="checkbox"
                            checked={stillInProgress}
                            onChange={(e) => {
                              setStillInProgress(e.target.checked);
                              if (e.target.checked) setWorkEnd('');
                            }}
                          />
                          아직 진행중이라 완료시간을 모릅니다(끝나면 다시 등록해주세요)
                        </label>
                      )}
                    </div>
                  </div>
                )
              )}

              {/* 영업조직(isSimplifiedMeetingForm)은 이 작업내용 입력칸을 아예 안 보여준다 — 화면에
                  없는 값은 submitDetailForm이 기본값으로 채워 보낸다(effectiveWorkDetail 참고). */}
              {!isSimplifiedMeetingForm && (
                <>
                  <label className="field-label">
                    {detailStatus === 'HQ_WORKING'
                      ? `오늘 수행업무 (필수 — 언제·무엇을·어떻게 했는지 구체적으로, 최소 15자)`
                      : detailStatus === 'CLIENT_MEETING' ? '미팅주제(무엇을/어떻게)' : '작업내용(무엇을/어떻게)'}
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
                </>
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

              {/* 영업조직은 작업위치(siteType)를 화면에서 안 묻고 기본값(현장)으로 자동 처리한다
                  (effectiveSiteType 참고) — 작업인원 항목도 같이 없앤다. */}
              {SITE_DETAIL_STATUSES.has(detailStatus) && !isSimplifiedMeetingForm && (
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
                  {(!(detailStatus === 'CLIENT_MEETING' || detailStatus === 'CLIENT_WORK') || showMoreFields) && (
                    <>
                      <label className="field-label">작업인원(본인 외 추가 투입 인원, 선택)</label>
                      <input value={personnel} onChange={(e) => setPersonnel(e.target.value)} placeholder="예: 홍길동, 김철수" />
                    </>
                  )}
                </>
              )}

              <button
                disabled={
                  // 영업조직은 작업내용 입력칸이 없으므로 이 최소글자수 검증을 건너뛴다(제출 시
                  // 자동으로 채워짐 — effectiveWorkDetail 참고).
                  // 2026-09-22: 고객사작업/미팅 등 일반 작업내용의 "최소 10자" 제약은 제거 요청으로
                  // 삭제하고 빈 값만 막는다 — 본사근무 업무일지(최소 15자)는 이번 요청 대상이
                  // 아니라서 그대로 둔다.
                  (!isSimplifiedMeetingForm && (detailStatus === 'HQ_WORKING' ? workDetail.trim().length < 15 : !workDetail.trim()))
                  || (!SIMPLIFIED_EFFORT_STATUSES.has(detailStatus) && !workReason.trim())
                  || (detailStatus === 'HQ_WORKING' ? !clientName.trim() : !workStart)
                  // 고객사미팅/고객사작업은 위 workStart 조건과 별개로 고객사 선택(clientName)도 필수다
                  // (목록에서 고르거나 새로 등록해야 확정되므로, 검색창 글자만 입력한 상태로는 등록 불가).
                  || (LOCATION_CHECK_STATUSES.has(detailStatus) && !clientName.trim())
                  || (SITE_DETAIL_STATUSES.has(detailStatus) && !siteType)
                  // 고객사작업/야간작업/주말작업은 완료시간도 필수다(2026-09-14 요청 — 고객사미팅은 제외).
                  // 단, "진행중" 체크박스를 켠 경우는 예외(2026-09-15).
                  || (END_TIME_REQUIRED_STATUSES.has(detailStatus) && !workEnd && !stillInProgress)
                  || detailSubmitting
                }
                onClick={handleDetailFormSubmit}
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
