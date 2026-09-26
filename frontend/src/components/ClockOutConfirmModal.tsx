import { useCallback, useEffect, useState } from 'react';
import { getCurrentLocationDetailed, locationFailureLabel, isLowAccuracy, accuracyWarningLabel, LOCATION_JUMP_WARNING, type LocationCaptureResult } from '@/lib/geolocation';
import SlideToConfirm from '@/components/SlideToConfirm';
import { apiFetch } from '@/lib/api';

interface Props {
  clockInAt: string;
  locationConsentGiven: boolean;
  onConfirm: (payload: {
    locationAddress?: string;
    locationStatus: string;
    earlyLeaveReason?: string;
    dailyWorkLog: DailyWorkLogPayload;
  }) => Promise<void>;
  onCancel: () => void;
}

// 2026-09-26: "일일업무일지" 1단계(대표이사 요청) — 퇴근 시 "이슈/특이사항"·"내일 예정 업무" 두
// 줄은 반드시 채워야 하루가 마감된다. 2단계 자동초안(GET /daily-work-log/draft)이 오늘 근무형태에
// 따라 간단형/상세형을 판단하고 나머지 필드를 미리 채워주며, 서버(attendance.routes.ts /clock-out)가
// 최종 검증을 한 번 더 한다.
export interface DailyWorkLogPayload {
  formType: 'SIMPLE' | 'DETAILED';
  workTypeSnapshot?: string;
  visitedClients?: string;
  workContent?: string;
  issues: string;
  followUp?: string;
  tomorrowPlan: string;
  supportRequest?: string;
  actualEffortMinutes?: number;
  autoDraftSnapshot?: string;
}

interface DraftResponse {
  formType: 'SIMPLE' | 'DETAILED';
  workTypeSnapshot: string | null;
  visitedClients: string | null;
  workContent: string | null;
  actualEffortMinutes: number | null;
  existing: {
    formType: 'SIMPLE' | 'DETAILED';
    workTypeSnapshot: string | null;
    visitedClients: string | null;
    workContent: string | null;
    issues: string;
    followUp: string | null;
    tomorrowPlan: string;
    supportRequest: string | null;
  } | null;
}

// 서버 기본 정책값(MIN_HOURS_BEFORE_CLOCKOUT)과 맞춘 화면 표시용 기준 — 관리자가 정책을
// 다르게 설정한 경우 서버가 최종 판단하며, 여기서는 사유 입력창을 보여줄지만 결정한다.
// (이 최소근무시간 기준은 "실제 근무장소에 있었던 시간" 기준이라 점심시간을 빼지 않은
// 출근~지금까지의 전체 경과시간으로 판단한다 — 서버 attendance.routes.ts의 /clock-out과 동일.)
const MIN_HOURS_DEFAULT_MINUTES = 8 * 60;
// 서버 정책값(LUNCH_BREAK_DEDUCTION_MINUTES) 기본값과 맞춘 화면 표시용 기준 — 실제로 오늘
// 근무시간으로 "기록되는" 시간은 점심시간 1시간을 뺀 값이므로, 안내 문구에는 이 값을 적용한다.
const LUNCH_BREAK_DEFAULT_MINUTES = 60;

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

const textareaStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
  background: '#0d1326', color: '#e7ebf5', border: '1px solid #212a45', fontFamily: 'inherit',
  fontSize: 13, resize: 'vertical', minHeight: 52,
};

/**
 * "퇴근" 버튼을 눌렀을 때 바로 처리하지 않고, 지금 무엇이 기록되는지 보여주고 한 번 더
 * 확인받는다 — 퇴근의 의미(시각+위치가 확정된다는 것)를 명확히 전달하기 위한 화면.
 * 위치는 모달이 뜨는 즉시 백그라운드로 확인을 시도해서, 확정을 누르는 시점엔 이미
 * 성공/실패(및 실패 사유)가 화면에 보이게 한다.
 * 2026-09-26: 여기에 "일일업무일지" 1·2단계(자동초안 + 필수 마감 입력)를 함께 얹었다 — 퇴근
 * 확정 = 하루 업무일지 마감이 한 화면·한 동작으로 끝나도록.
 */
export default function ClockOutConfirmModal({ clockInAt, locationConsentGiven, onConfirm, onCancel }: Props) {
  const [locationResult, setLocationResult] = useState<LocationCaptureResult | 'checking'>('checking');
  const [submitting, setSubmitting] = useState(false);
  const [earlyLeaveReason, setEarlyLeaveReason] = useState('');
  const [showEarlyLeaveError, setShowEarlyLeaveError] = useState(false);

  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [formType, setFormType] = useState<'SIMPLE' | 'DETAILED'>('SIMPLE');
  const [visitedClients, setVisitedClients] = useState('');
  const [workContent, setWorkContent] = useState('');
  const [issues, setIssues] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [tomorrowPlan, setTomorrowPlan] = useState('');
  const [supportRequest, setSupportRequest] = useState('');
  const [showWorkLogError, setShowWorkLogError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<DraftResponse>('/daily-work-log/draft').then((d) => {
      if (cancelled) return;
      setDraft(d);
      // 이미 오늘치를 한 번 제출한 적이 있으면(퇴근 정정 등으로 다시 여는 경우) 자동초안 대신
      // 그때 저장해둔 값을 우선 보여준다 — 자동초안으로 덮어써서 고쳐둔 내용을 잃어버리지 않게.
      const e = d.existing;
      setFormType(e?.formType ?? d.formType);
      setVisitedClients(e?.visitedClients ?? d.visitedClients ?? '');
      setWorkContent(e?.workContent ?? d.workContent ?? '');
      setIssues(e?.issues ?? '');
      setFollowUp(e?.followUp ?? '');
      setTomorrowPlan(e?.tomorrowPlan ?? '');
      setSupportRequest(e?.supportRequest ?? '');
    }).catch(() => {
      // 자동초안 조회 실패해도 마감 자체는 막지 않는다 — 빈 폼으로 직접 입력하면 된다.
    });
    return () => { cancelled = true; };
  }, []);

  const refreshLocation = useCallback(() => {
    setLocationResult('checking');
    return getCurrentLocationDetailed(locationConsentGiven).then((result) => {
      setLocationResult(result);
      return result;
    });
  }, [locationConsentGiven]);

  useEffect(() => {
    let cancelled = false;
    getCurrentLocationDetailed(locationConsentGiven).then((result) => {
      if (!cancelled) setLocationResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [locationConsentGiven]);

  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(clockInAt).getTime()) / 60000));
  const isEarlyLeave = elapsedMinutes < MIN_HOURS_DEFAULT_MINUTES;
  // 실제로 오늘 근무시간으로 기록되는 값(점심시간 1시간 공제) — 안내 문구 전용, 최소근무시간
  // 판단(isEarlyLeave)에는 영향을 주지 않는다(서버도 그 판단은 순수 경과시간 기준).
  const recordedMinutes = Math.max(0, elapsedMinutes - LUNCH_BREAK_DEFAULT_MINUTES);
  // 이상치(순간이동) 감지 시 퇴근 확정을 막고 재측정을 유도한다(2026-09 요청 — 등록 차단).
  const jumpDetected = locationResult !== 'checking' && locationResult.jumpDetected;
  const workLogMissing = !issues.trim() || !tomorrowPlan.trim();

  // 2026-09-16: 슬라이더(SlideToConfirm)의 onConfirm은 반환값이 false면 손잡이를 원위치로
  // 되돌리고 확정 처리하지 않는다 — 조기퇴근 사유 미입력처럼 아직 확정하면 안 되는 경우 그대로
  // 활용한다(기존엔 버튼 클릭을 그냥 무시하고 인라인 에러만 보여줬었다).
  async function handleConfirm(): Promise<boolean> {
    if (jumpDetected) return false;
    if (isEarlyLeave && !earlyLeaveReason.trim()) {
      setShowEarlyLeaveError(true);
      return false;
    }
    if (workLogMissing) {
      setShowWorkLogError(true);
      return false;
    }
    setSubmitting(true);
    try {
      const result = locationResult === 'checking' ? { status: 'TIMEOUT' as const, address: null, accuracyMeters: null } : locationResult;
      await onConfirm({
        locationAddress: result.address ?? undefined,
        locationStatus: result.status,
        earlyLeaveReason: earlyLeaveReason.trim() || undefined,
        dailyWorkLog: {
          formType,
          workTypeSnapshot: draft?.workTypeSnapshot ?? undefined,
          visitedClients: visitedClients.trim() || undefined,
          workContent: workContent.trim() || undefined,
          issues: issues.trim(),
          followUp: followUp.trim() || undefined,
          tomorrowPlan: tomorrowPlan.trim(),
          supportRequest: supportRequest.trim() || undefined,
          actualEffortMinutes: draft?.actualEffortMinutes ?? undefined,
          autoDraftSnapshot: draft?.workContent ?? undefined,
        },
      });
      return true;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto',
      }}
    >
      <div style={{ background: '#10162a', color: '#e7ebf5', border: '1px solid #212a45', borderRadius: 16, padding: 28, maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>🏁 퇴근 처리 · 오늘 업무일지</h2>
        <p style={{ fontSize: 14, color: '#9aa5c3', lineHeight: 1.6 }}>
          지금 퇴근 처리하시겠어요? <strong>현재 시각</strong>이 오늘의 퇴근 시각으로 확정되고,
          점심시간 1시간을 제외한 <strong>{hoursLabel(recordedMinutes)}</strong>이 오늘 근무시간으로 기록됩니다.
          한 번 확정하면 본인이 직접 되돌릴 수 없어요.
        </p>
        <div
          style={{
            background: locationResult === 'checking' ? '#151c34' : jumpDetected ? 'rgba(239,68,68,0.14)' : locationResult.status === 'OK' ? 'rgba(34,197,94,0.14)' : 'rgba(245,158,11,0.14)',
            border: `1px solid ${locationResult === 'checking' ? '#232b45' : jumpDetected ? '#7f1d1d' : locationResult.status === 'OK' ? '#1f4a2e' : '#4a3a12'}`,
            borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 13, lineHeight: 1.5,
          }}
        >
          {locationResult === 'checking' && '📍 위치 확인 중...'}
          {locationResult !== 'checking' && jumpDetected && (
            <>
              {LOCATION_JUMP_WARNING}
              <button
                type="button"
                className="secondary"
                style={{ width: 'auto', margin: '8px 0 0', padding: '6px 12px', fontSize: 12 }}
                onClick={() => refreshLocation()}
              >
                📍 위치 다시 확인
              </button>
            </>
          )}
          {locationResult !== 'checking' && !jumpDetected && locationResult.status === 'OK' && `📍 ${locationResult.address}`}
          {locationResult !== 'checking' && !jumpDetected && locationResult.status !== 'OK' && (
            <>
              📍 위치 없이 퇴근 기록됩니다 — {locationFailureLabel(locationResult.status)}.
            </>
          )}
          {locationResult !== 'checking' && !jumpDetected && isLowAccuracy(locationResult.accuracyMeters) && (
            <div style={{ marginTop: 6, color: '#fbbf24' }}>
              ⚠️ {accuracyWarningLabel(locationResult.accuracyMeters as number)}
            </div>
          )}
        </div>
        {isEarlyLeave && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#fbbf24', marginBottom: 6 }}>
              ⏱️ 아직 최소 근무시간(8시간) 전이에요 — 조기퇴근 사유를 입력해주세요
            </label>
            <input
              type="text"
              value={earlyLeaveReason}
              onChange={(e) => { setEarlyLeaveReason(e.target.value); setShowEarlyLeaveError(false); }}
              placeholder="예: 병원 진료로 조기퇴근"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, background: '#0d1326', color: '#e7ebf5', border: `1px solid ${showEarlyLeaveError ? '#ef4444' : '#212a45'}` }}
            />
            {showEarlyLeaveError && (
              <div style={{ fontSize: 12, color: '#f87171', marginTop: 4 }}>사유를 입력해야 조기퇴근으로 확정할 수 있어요.</div>
            )}
            <div style={{ fontSize: 11, color: '#6b7594', marginTop: 4 }}>부족한 시간은 이번 주 누계에 그대로 반영되어, 다른 날 초과근무와 자연스럽게 합산됩니다.</div>
          </div>
        )}

        <div style={{ borderTop: '1px solid #212a45', margin: '4px 0 16px', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>📓 오늘의 업무일지</span>
            <span style={{ fontSize: 11, color: '#6b7594' }}>
              {draft === null ? '자동초안 불러오는 중...' : formType === 'DETAILED' ? '상세형(오늘 근무형태 기준)' : '간단형'}
            </span>
          </div>

          {formType === 'DETAILED' && (
            <>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9aa5c3', marginBottom: 4 }}>방문 고객사/현장</label>
                <input
                  type="text"
                  value={visitedClients}
                  onChange={(e) => setVisitedClients(e.target.value)}
                  placeholder="예: OO은행 본점, XX증권"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, background: '#0d1326', color: '#e7ebf5', border: '1px solid #212a45' }}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9aa5c3', marginBottom: 4 }}>주요 작업내용</label>
                <textarea value={workContent} onChange={(e) => setWorkContent(e.target.value)} placeholder="오늘 자동으로 모인 작업 기록이에요 — 필요하면 고쳐주세요." style={textareaStyle} />
              </div>
            </>
          )}

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: showWorkLogError && !issues.trim() ? '#f87171' : '#fbbf24', marginBottom: 4 }}>
              이슈 및 특이사항 *
            </label>
            <textarea
              value={issues}
              onChange={(e) => { setIssues(e.target.value); setShowWorkLogError(false); }}
              placeholder="예: 특이사항 없음 / OO건 장애 대응중, 내일 재확인 필요"
              style={{ ...textareaStyle, border: `1px solid ${showWorkLogError && !issues.trim() ? '#ef4444' : '#212a45'}` }}
            />
          </div>

          {formType === 'DETAILED' && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#9aa5c3', marginBottom: 4 }}>후속조치/미해결 건</label>
              <textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="선택 입력" style={textareaStyle} />
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: showWorkLogError && !tomorrowPlan.trim() ? '#f87171' : '#fbbf24', marginBottom: 4 }}>
              내일 예정 업무 *
            </label>
            <textarea
              value={tomorrowPlan}
              onChange={(e) => { setTomorrowPlan(e.target.value); setShowWorkLogError(false); }}
              placeholder="예: OO고객사 정기점검, XX건 이어서 진행"
              style={{ ...textareaStyle, border: `1px solid ${showWorkLogError && !tomorrowPlan.trim() ? '#ef4444' : '#212a45'}` }}
            />
          </div>

          {formType === 'DETAILED' && (
            <div style={{ marginBottom: 4 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#9aa5c3', marginBottom: 4 }}>지원요청/공유사항</label>
              <textarea value={supportRequest} onChange={(e) => setSupportRequest(e.target.value)} placeholder="선택 입력" style={textareaStyle} />
            </div>
          )}

          {showWorkLogError && workLogMissing && (
            <div style={{ fontSize: 12, color: '#f87171', marginTop: 4 }}>이슈/특이사항과 내일 예정 업무는 반드시 입력해야 퇴근이 확정돼요.</div>
          )}
        </div>

        {/* 2026-09-16: "퇴근을 잘못 눌렀다"는 신고(채수권·윤유상 등)가 반복돼서, 되돌릴 수 없다고
            안내만 하던 탭 버튼을 밀어서 확정하는 슬라이더로 바꿨다 — 뜬 직후 잠깐은 밀어도 반응하지
            않고 끝까지 밀어야만 확정되므로, 스치는 터치 한 번으로는 퇴근이 확정되지 않는다. */}
        <SlideToConfirm
          onConfirm={handleConfirm}
          label="밀어서 퇴근 확정"
          disabled={jumpDetected}
          disabledHint="위치 재확인 필요"
        />
        <button className="secondary" disabled={submitting} style={{ marginTop: 8 }} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
