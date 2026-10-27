import { useCallback, useEffect, useState } from 'react';
import { getCurrentLocationDetailed, locationFailureLabel, isLowAccuracy, accuracyWarningLabel, LOCATION_JUMP_WARNING, type LocationCaptureResult } from '@/lib/geolocation';
import SlideToConfirm from '@/components/SlideToConfirm';
import { isMeaningfulPlan, PLAN_RULE_MESSAGE } from '@/lib/work-log-rules';
import { apiFetch } from '@/lib/api';
import SuggestionChips from '@/components/SuggestionChips';
import { appendSuggestion, type DraftSuggestions } from '@/lib/work-log-suggest';
import AiAssistPanel from '@/components/AiAssistPanel';

interface Props {
  clockInAt: string;
  locationConsentGiven: boolean;
  onConfirm: (payload: {
    locationAddress?: string;
    locationStatus: string;
    // 2026-10-11: 서버가 본사/고객사 어디서 퇴근했는지 판정하는 데만 쓰고 저장하지 않는다.
    location?: { lat: number; lng: number };
    accuracyMeters?: number;
    // 위치를 확인할 수 없을 때 직원이 직접 적는 사유(5자 이상) — 퇴근은 확정되고 관리자 확인 대상으로 남는다.
    locationFailureReason?: string;
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
  // 2026-09-29: "미등록 공백시간" 사유 — draft.unloggedGap이 감지됐을 때만 채워서 보낸다.
  unloggedGapMinutes?: number;
  unloggedGapReason?: string;
}

interface DraftResponse {
  formType: 'SIMPLE' | 'DETAILED';
  workTypeSnapshot: string | null;
  visitedClients: string | null;
  workContent: string | null;
  actualEffortMinutes: number | null;
  // 2026-10-15: 작업 설명을 안 적은 작업 기록 수 + 이슈/후속조치/내일 예정 업무 제안 문구(눌러서 넣는 칩).
  missingDescriptionCount?: number;
  suggestions?: DraftSuggestions;
  // 2026-10-15: AI 보조(문장 다듬기·말/메모로 채우기) 사용 가능 여부 — 서버 설정이 꺼져 있으면 false.
  aiAssistEnabled?: boolean;
  history?: {
    previousPlan: { workDate: string; text: string } | null;
    followUps: { workDate: string; text: string; sameClient: boolean }[];
    lastVisits: { clientName: string; workDate: string; workType: string; description: string }[];
  };
  // 2026-09-29: "미등록 공백시간" — 마지막으로 종료시간이 찍힌 작업 이후 새로 등록된 상태 없이
  // 지금(퇴근 직전 조회 시점)까지 공백이 임계값 이상이면 채워진다. 없으면 null.
  unloggedGap: { minutes: number; sinceISO: string } | null;
  existing: {
    formType: 'SIMPLE' | 'DETAILED';
    workTypeSnapshot: string | null;
    visitedClients: string | null;
    workContent: string | null;
    issues: string;
    followUp: string | null;
    tomorrowPlan: string;
    supportRequest: string | null;
    unloggedGapReason: string | null;
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
  background: '#f5f7fb', color: '#1f2937', border: '1px solid #d5dbe6', fontFamily: 'inherit',
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
  const [locationFailureReason, setLocationFailureReason] = useState('');

  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [formType, setFormType] = useState<'SIMPLE' | 'DETAILED'>('SIMPLE');
  const [visitedClients, setVisitedClients] = useState('');
  const [workContent, setWorkContent] = useState('');
  const [issues, setIssues] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [tomorrowPlan, setTomorrowPlan] = useState('');
  const [supportRequest, setSupportRequest] = useState('');
  const [unloggedGapReason, setUnloggedGapReason] = useState('');
  const [showWorkLogError, setShowWorkLogError] = useState(false);
  // 2026-09-30 수정: 서버가 퇴근 확정을 거절한 사유(예: 미등록 공백시간 사유 누락)를 모달 안에
  // 보여주기 위한 상태 — 예전엔 실패해도 모달이 그냥 닫혀서, 방금 입력한 업무일지가 사라지고
  // 페이지 뒤쪽 메시지도 모달에 가려 보이지 않았다.
  const [submitError, setSubmitError] = useState<string | null>(null);

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
      setUnloggedGapReason(e?.unloggedGapReason ?? '');
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
  const unloggedGapRequired = !!draft?.unloggedGap;
  // 2026-10-12: 내일 예정 업무는 "."/"없음"/"미정" 같은 의미 없는 값을 받지 않는다(3글자 이상, 휴가·반차 등은 예외).
  // 2026-10-20: 금요일은 내일 예정 업무를 받지 않는다(당일 업무일지로 마감). 서버는 값을 요구하므로 고정 문구를 보낸다.
  const isFridayKst = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay() === 5;
  const FRIDAY_PLAN_TEXT = '금요일 마감 (주말 휴무)';
  const planInvalid = !isFridayKst && !isMeaningfulPlan(tomorrowPlan);
  const workLogMissing = !issues.trim() || planInvalid || (unloggedGapRequired && !unloggedGapReason.trim());

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
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = locationResult === 'checking' ? { status: 'TIMEOUT' as const, address: null, accuracyMeters: null } : locationResult;
      const locationOk = result.status === 'OK' || Boolean((result as LocationCaptureResult).coords);
      await onConfirm({
        locationAddress: result.address ?? undefined,
        locationStatus: result.status,
        ...((result as LocationCaptureResult).coords ? { location: (result as LocationCaptureResult).coords as { lat: number; lng: number } } : {}),
        ...(typeof result.accuracyMeters === 'number' ? { accuracyMeters: result.accuracyMeters } : {}),
        ...(!locationOk && locationFailureReason.trim() ? { locationFailureReason: locationFailureReason.trim() } : {}),
        earlyLeaveReason: earlyLeaveReason.trim() || undefined,
        dailyWorkLog: {
          formType,
          workTypeSnapshot: draft?.workTypeSnapshot ?? undefined,
          visitedClients: visitedClients.trim() || undefined,
          workContent: workContent.trim() || undefined,
          issues: issues.trim(),
          followUp: followUp.trim() || undefined,
          tomorrowPlan: isFridayKst ? FRIDAY_PLAN_TEXT : tomorrowPlan.trim(),
          supportRequest: supportRequest.trim() || undefined,
          actualEffortMinutes: draft?.actualEffortMinutes ?? undefined,
          autoDraftSnapshot: draft?.workContent ?? undefined,
          unloggedGapMinutes: draft?.unloggedGap?.minutes,
          unloggedGapReason: unloggedGapRequired ? unloggedGapReason.trim() : undefined,
        },
      });
      return true;
    } catch (err) {
      // 2026-09-30 수정: 서버가 거절하면 모달을 닫지 않고 그 사유를 안에서 보여준다 —
      // 작성한 업무일지/사유가 사라지지 않게 하기 위함(호출부가 에러를 다시 던져준다).
      setSubmitError(err instanceof Error ? err.message : '퇴근 처리에 실패했습니다.');
      return false;
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
      <div style={{ background: '#ffffff', color: '#1f2937', border: '1px solid #d5dbe6', borderRadius: 16, padding: 28, maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>🏁 퇴근 처리 · 오늘 업무일지</h2>
        <p style={{ fontSize: 14, color: '#5b6478', lineHeight: 1.6 }}>
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
              📍 퇴근 위치를 확인하지 못했어요 — {locationFailureLabel(locationResult.status)}.
              <div style={{ marginTop: 6, color: '#fbbf24' }}>
                본사/고객사 현장에서 퇴근하는 경우 위치 확인이 필요해요. 위치 접근을 허용하고 건물 밖에서 다시 확인해 보세요.
              </div>
              <button
                type="button"
                className="secondary"
                style={{ width: 'auto', margin: '8px 0 0', padding: '6px 12px', fontSize: 12 }}
                onClick={() => refreshLocation()}
              >
                📍 위치 다시 확인
              </button>
              <input
                type="text"
                value={locationFailureReason}
                onChange={(e) => setLocationFailureReason(e.target.value)}
                placeholder="정말 위치를 확인할 수 없다면 사유를 적어주세요(5자 이상)"
                style={{ marginTop: 8 }}
              />
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
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, background: '#f5f7fb', color: '#1f2937', border: `1px solid ${showEarlyLeaveError ? '#ef4444' : '#d5dbe6'}` }}
            />
            {showEarlyLeaveError && (
              <div style={{ fontSize: 12, color: '#f87171', marginTop: 4 }}>사유를 입력해야 조기퇴근으로 확정할 수 있어요.</div>
            )}
            <div style={{ fontSize: 11, color: '#8a93a8', marginTop: 4 }}>부족한 시간은 이번 주 누계에 그대로 반영되어, 다른 날 초과근무와 자연스럽게 합산됩니다.</div>
          </div>
        )}

        <div style={{ borderTop: '1px solid #d5dbe6', margin: '4px 0 16px', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>📓 오늘의 업무일지</span>
            <span style={{ fontSize: 11, color: '#8a93a8' }}>
              {draft === null ? '자동초안 불러오는 중...' : formType === 'DETAILED' ? '상세형(오늘 근무형태 기준)' : '간단형'}
            </span>
          </div>

          {draft?.history && (draft.history.previousPlan || draft.history.followUps.length > 0 || draft.history.lastVisits.length > 0) && (
            <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 10, background: '#f5f7fb', border: '1px solid #d5dbe6', fontSize: 12.5, lineHeight: 1.6, color: '#1f2937' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                📌 이어쓰기 도우미 <span style={{ fontWeight: 400, color: '#5b6478' }}>— 참고용이에요. 내 지난 기록만 보여드리며, 아래 입력칸에서 자유롭게 수정하세요</span>
              </div>
              {((pp) => pp && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: '#5b6478' }}>{pp.workDate.slice(5).replace('-', '/')}에 적은 내일 예정 업무 — 오늘 하셨나요?</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{pp.text}</div>
                  {formType === 'DETAILED' && (
                    <button type="button" style={{ marginTop: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid #d5dbe6', background: '#ffffff', color: '#1f2937', fontSize: 12, cursor: 'pointer' }} onClick={() => setWorkContent((c) => (c.trim() ? c.trim() + '\n' : '') + '[어제 계획 수행] ' + pp.text)}>했어요 · 작업 내용에 추가</button>
                  )}
                  {formType === 'SIMPLE' && (
                    <button type="button" style={{ marginTop: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid #d5dbe6', background: '#ffffff', color: '#1f2937', fontSize: 12, cursor: 'pointer' }} onClick={() => setTomorrowPlan((c) => (c.trim() ? c.trimEnd() + '\n' : '') + pp.text)}>아직이에요 · 내일 예정 업무에 이어쓰기</button>
                  )}
                </div>
              ))(draft.history.previousPlan)}
              {draft.history.followUps.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: '#5b6478' }}>이전에 남긴 후속조치 — 해결됐나요?</div>
                  {draft.history.followUps.map((f, i) => (
                    <div key={i} style={{ marginTop: 2 }}>
                      <span style={{ color: '#5b6478' }}>{f.workDate.slice(5).replace('-', '/')}{f.sameClient ? ' · 오늘 방문한 고객사' : ''}</span> {f.text}
                      <div>
                        <button type="button" style={{ marginTop: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid #d5dbe6', background: '#ffffff', color: '#1f2937', fontSize: 12, cursor: 'pointer' }} onClick={() => (formType === 'DETAILED' ? setFollowUp((c) => (c.trim() ? c.trim() + '\n' : '') + '[이어서] ' + f.text) : setIssues((c) => (c.trim() ? c.trim() + '\n' : '') + '[이어서] ' + f.text))}>아직이에요 · 이어쓰기</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {draft.history.lastVisits.length > 0 && (
                <div>
                  <div style={{ color: '#5b6478' }}>오늘 방문한 고객사의 지난 작업</div>
                  {draft.history.lastVisits.map((v) => (
                    <div key={v.clientName} style={{ marginTop: 2 }}>
                      <b>{v.clientName}</b> <span style={{ color: '#5b6478' }}>({v.workDate.slice(5).replace('-', '/')}{v.workType ? ' · ' + v.workType : ''})</span>{v.description ? ' ' + v.description : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {draft?.suggestions && (draft.suggestions.issues.length + draft.suggestions.followUp.length + draft.suggestions.tomorrowPlan.length) > 0 && (
            <div style={{ fontSize: 11.5, color: '#5b6478', marginBottom: 10, lineHeight: 1.5 }}>
              ✨ 오늘 기록을 바탕으로 만든 제안이에요. 눌러서 넣고 내용을 고쳐 쓰세요.
            </div>
          )}

          {draft?.aiAssistEnabled && (
            <AiAssistPanel
              formType={formType}
              values={{ issues, followUp, tomorrowPlan }}
              onApply={(field, text, mode) => {
                const put = (cur: string) => (mode === 'polish' ? text : appendSuggestion(cur, text));
                if (field === 'issues') setIssues(put);
                else if (field === 'followUp') setFollowUp(put);
                else setTomorrowPlan(put);
                setShowWorkLogError(false);
              }}
            />
          )}

          {unloggedGapRequired && draft?.unloggedGap && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ background: 'rgba(239,68,68,0.14)', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 12px', marginBottom: 6, fontSize: 12.5, lineHeight: 1.5 }}>
                ⚠️ 마지막 등록된 작업 종료(
                {new Date(draft.unloggedGap.sinceISO).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' })}
                ) 이후 <strong>{Math.floor(draft.unloggedGap.minutes / 60)}시간 {draft.unloggedGap.minutes % 60}분</strong> 동안 등록된 활동이 없어요. 근무시간엔 그대로 반영되니, 그 사이 무엇을 하셨는지 적어주세요.
              </div>
              <textarea
                value={unloggedGapReason}
                onChange={(e) => { setUnloggedGapReason(e.target.value); setShowWorkLogError(false); }}
                placeholder="예: 다음 고객사 이동 및 대기, 개인 용무 등"
                style={{ ...textareaStyle, border: `1px solid ${showWorkLogError && !unloggedGapReason.trim() ? '#ef4444' : '#d5dbe6'}` }}
              />
            </div>
          )}

          {formType === 'DETAILED' && (
            <>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#5b6478', marginBottom: 4 }}>방문 고객사/현장</label>
                <input
                  type="text"
                  value={visitedClients}
                  onChange={(e) => setVisitedClients(e.target.value)}
                  placeholder="예: OO은행 본점, XX증권"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, background: '#f5f7fb', color: '#1f2937', border: '1px solid #d5dbe6' }}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#5b6478', marginBottom: 4 }}>주요 작업내용</label>
                <textarea value={workContent} onChange={(e) => setWorkContent(e.target.value)} placeholder="오늘 자동으로 모인 작업 기록이에요 — 필요하면 고쳐주세요." style={{ ...textareaStyle, minHeight: 110 }} />
                {(draft?.missingDescriptionCount ?? 0) > 0 && (
                  <div data-testid="missing-description" style={{ fontSize: 11.5, color: '#fbbf24', marginTop: 4, lineHeight: 1.5 }}>
                    💡 작업 설명을 적지 않은 기록이 {draft?.missingDescriptionCount}건 있어요. 항목 아래에 "→ 한 일"을 한 줄씩 적어주세요.
                  </div>
                )}
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
              style={{ ...textareaStyle, border: `1px solid ${showWorkLogError && !issues.trim() ? '#ef4444' : '#d5dbe6'}` }}
            />
            <SuggestionChips testId="chips-issues" items={draft?.suggestions?.issues ?? []} current={issues} onPick={(t) => { setIssues((c) => appendSuggestion(c, t)); setShowWorkLogError(false); }} />
          </div>

          {formType === 'DETAILED' && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#5b6478', marginBottom: 4 }}>후속조치/미해결 건</label>
              <textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="선택 입력" style={textareaStyle} />
              <SuggestionChips testId="chips-followup" items={draft?.suggestions?.followUp ?? []} current={followUp} onPick={(t) => setFollowUp((c) => appendSuggestion(c, t))} />
            </div>
          )}

          {isFridayKst && (
            <div style={{ marginBottom: 10, padding: '12px 14px', borderRadius: 10, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', fontSize: 13.5, lineHeight: 1.6 }}>
              🎉 오늘은 금요일이에요. 내일 작업은 입력하지 않으셔도 되고, 오늘 업무일지로 한 주를 마감합니다. 한 주도 고생 많으셨어요. 즐거운 휴일 보내세요!
            </div>
          )}
          <div style={{ marginBottom: 10, display: isFridayKst ? 'none' : undefined }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: showWorkLogError && planInvalid ? '#f87171' : '#fbbf24', marginBottom: 4 }}>
              내일 예정 업무 *
            </label>
            <textarea
              value={tomorrowPlan}
              onChange={(e) => { setTomorrowPlan(e.target.value); setShowWorkLogError(false); }}
              placeholder="예: OO고객사 정기점검, XX건 이어서 진행 (3글자 이상 · 쉬는 날은 '휴가')"
              style={{ ...textareaStyle, border: `1px solid ${showWorkLogError && planInvalid ? '#ef4444' : '#d5dbe6'}` }}
            />
            <SuggestionChips testId="chips-plan" items={draft?.suggestions?.tomorrowPlan ?? []} current={tomorrowPlan} onPick={(t) => { setTomorrowPlan((c) => appendSuggestion(c, t)); setShowWorkLogError(false); }} />
          </div>

          {formType === 'DETAILED' && (
            <div style={{ marginBottom: 4 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#5b6478', marginBottom: 4 }}>지원요청/공유사항</label>
              <textarea value={supportRequest} onChange={(e) => setSupportRequest(e.target.value)} placeholder="선택 입력" style={textareaStyle} />
            </div>
          )}

          {showWorkLogError && workLogMissing && (
            <div style={{ fontSize: 12, color: '#f87171', marginTop: 4 }}>
              {issues.trim() && tomorrowPlan.trim() && planInvalid
                ? PLAN_RULE_MESSAGE
                : `${isFridayKst ? '이슈/특이사항' : '이슈/특이사항과 내일 예정 업무'}${unloggedGapRequired ? ', 그리고 위 공백시간 사유' : ''}${(isFridayKst && !unloggedGapRequired) ? '은' : '는'} 반드시 입력해야 퇴근이 확정돼요.`}
            </div>
          )}
        </div>

        {submitError && (
          <div style={{ background: 'rgba(239,68,68,0.14)', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#f87171', marginBottom: 12, lineHeight: 1.6 }}>
            ⚠ {submitError}
          </div>
        )}

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
