import { useEffect, useState } from 'react';
import { getCurrentLocationDetailed, locationFailureLabel, type LocationCaptureResult } from '@/lib/geolocation';

interface Props {
  clockInAt: string;
  locationConsentGiven: boolean;
  onConfirm: (payload: { locationAddress?: string; locationStatus: string; earlyLeaveReason?: string }) => Promise<void>;
  onCancel: () => void;
}

// 서버 기본 정책값(MIN_HOURS_BEFORE_CLOCKOUT)과 맞춘 화면 표시용 기준 — 관리자가 정책을
// 다르게 설정한 경우 서버가 최종 판단하며, 여기서는 사유 입력창을 보여줄지만 결정한다.
const MIN_HOURS_DEFAULT_MINUTES = 8 * 60;

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

  async function handleConfirm() {
    if (isEarlyLeave && !earlyLeaveReason.trim()) {
      setShowEarlyLeaveError(true);
      return;
    }
    setSubmitting(true);
    try {
      const result = locationResult === 'checking' ? { status: 'TIMEOUT' as const, address: null } : locationResult;
      await onConfirm({
        locationAddress: result.address ?? undefined,
        locationStatus: result.status,
        earlyLeaveReason: earlyLeaveReason.trim() || undefined,
      });
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
          출근 이후 <strong>{hoursLabel(elapsedMinutes)}</strong>이 오늘 근무시간으로 기록됩니다.
          한 번 확정하면 본인이 직접 되돌릴 수 없어요.
        </p>
        <div
          style={{
            background: locationResult === 'checking' ? '#151c34' : locationResult.status === 'OK' ? 'rgba(34,197,94,0.14)' : 'rgba(245,158,11,0.14)',
            border: `1px solid ${locationResult === 'checking' ? '#232b45' : locationResult.status === 'OK' ? '#1f4a2e' : '#4a3a12'}`,
            borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 13, lineHeight: 1.5,
          }}
        >
          {locationResult === 'checking' && '📍 위치 확인 중...'}
          {locationResult !== 'checking' && locationResult.status === 'OK' && `📍 ${locationResult.address}`}
          {locationResult !== 'checking' && locationResult.status !== 'OK' && (
            <>
              📍 위치 없이 퇴근 기록됩니다 — {locationFailureLabel(locationResult.status)}.
            </>
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
        <button disabled={submitting} onClick={handleConfirm}>
          {submitting ? '처리 중...' : '퇴근 확정'}
        </button>
        <button className="secondary" disabled={submitting} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
