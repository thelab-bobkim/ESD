import { useCallback, useEffect, useState } from 'react';
import { getCurrentLocationDetailed, locationFailureLabel, isLowAccuracy, accuracyWarningLabel, LOCATION_JUMP_WARNING, type LocationCaptureResult } from '@/lib/geolocation';
import SlideToConfirm from '@/components/SlideToConfirm';

interface Props {
  clockInAt: string;
  locationConsentGiven: boolean;
  onConfirm: (payload: { locationAddress?: string; locationStatus: string; earlyLeaveReason?: string }) => Promise<void>;
  onCancel: () => void;
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

/**
 * "퇴근" 버튼을 눌렀을 때 바로 처리하지 않고, 지금 무엇이 기록되는지 보여주고 한 번 더
 * 확인받는다 — 퇴근의 의미(시각+위치가 확정된다는 것)를 명확히 전달하기 위한 화면.
 * 위치는 모달이 뜨는 즉시 백그라운드로 확인을 시도해서, 확정을 누르는 시점엔 이미
 * 성공/실패(및 실패 사유)가 화면에 보이게 한다.
 */
export default function ClockOutConfirmModal({ clockInAt, locationConsentGiven, onConfirm, onCancel }: Props) {
  const [locationResult, setLocationResult] = useState<LocationCaptureResult | 'checking'>('checking');
  const [submitting, setSubmitting] = useState(false);
  const [earlyLeaveReason, setEarlyLeaveReason] = useState('');
  const [showEarlyLeaveError, setShowEarlyLeaveError] = useState(false);

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

  // 2026-09-16: 슬라이더(SlideToConfirm)의 onConfirm은 반환값이 false면 손잡이를 원위치로
  // 되돌리고 확정 처리하지 않는다 — 조기퇴근 사유 미입력처럼 아직 확정하면 안 되는 경우 그대로
  // 활용한다(기존엔 버튼 클릭을 그냥 무시하고 인라인 에러만 보여줬었다).
  async function handleConfirm(): Promise<boolean> {
    if (jumpDetected) return false;
    if (isEarlyLeave && !earlyLeaveReason.trim()) {
      setShowEarlyLeaveError(true);
      return false;
    }
    setSubmitting(true);
    try {
      const result = locationResult === 'checking' ? { status: 'TIMEOUT' as const, address: null, accuracyMeters: null } : locationResult;
      await onConfirm({
        locationAddress: result.address ?? undefined,
        locationStatus: result.status,
        earlyLeaveReason: earlyLeaveReason.trim() || undefined,
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
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{ background: '#10162a', color: '#e7ebf5', border: '1px solid #212a45', borderRadius: 16, padding: 28, maxWidth: 420, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>🏁 퇴근 처리</h2>
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
