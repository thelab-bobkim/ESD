import { useEffect, useState } from 'react';
import { getCurrentLocationDetailed, locationFailureLabel, type LocationCaptureResult } from '@/lib/geolocation';

interface Props {
  clockInAt: string;
  locationConsentGiven: boolean;
  onConfirm: (payload: { locationAddress?: string; locationStatus: string }) => Promise<void>;
  onCancel: () => void;
}

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

  async function handleConfirm() {
    setSubmitting(true);
    try {
      const result = locationResult === 'checking' ? { status: 'TIMEOUT' as const, address: null } : locationResult;
      await onConfirm({
        locationAddress: result.address ?? undefined,
        locationStatus: result.status,
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
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 420, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>🏁 퇴근 처리</h2>
        <p style={{ fontSize: 14, color: '#495057', lineHeight: 1.6 }}>
          지금 퇴근 처리하시겠어요? <strong>현재 시각</strong>이 오늘의 퇴근 시각으로 확정되고,
          출근 이후 <strong>{hoursLabel(elapsedMinutes)}</strong>이 오늘 근무시간으로 기록됩니다.
          한 번 확정하면 본인이 직접 되돌릴 수 없어요.
        </p>
        <div
          style={{
            background: locationResult === 'checking' ? '#f1f3f5' : locationResult.status === 'OK' ? '#ebfbee' : '#fff4e6',
            border: `1px solid ${locationResult === 'checking' ? '#dee2e6' : locationResult.status === 'OK' ? '#69db7c' : '#ffa94d'}`,
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
