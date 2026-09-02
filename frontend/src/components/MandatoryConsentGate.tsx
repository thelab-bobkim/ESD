import { useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, clearToken } from '@/lib/api';
import { getCurrentLocationWithStatus, locationFailureLabel } from '@/lib/geolocation';

interface Props {
  needsPrivacy: boolean;
  needsLocation: boolean;
  onComplete: () => void;
}

/**
 * 앱 사용의 필수 전제조건(개인정보 수집·이용 동의 + 위치정보 이용 동의)을 받기 전까지 화면을 가리는
 * 전체화면 오버레이. 2026-08-30, 엔지니어/과장급 전사 확산에 맞춰 도입 — 예전 LocationConsentModal과
 * 달리 "나중에 하기" 건너뛰기가 없다: 동의하거나, 로그아웃하거나 둘 중 하나만 가능하다.
 * 위치정보 동의는 서버 기록뿐 아니라 실제 브라우저 위치 권한이 허용되어야(getCurrentLocationWithStatus
 * 가 OK를 돌려줘야) 통과된다 — 체크박스만 누르고 브라우저 권한은 거부한 상태로 넘어가는 걸 막기 위함.
 */
export default function MandatoryConsentGate({ needsPrivacy, needsLocation, onComplete }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<'privacy' | 'location'>(needsPrivacy ? 'privacy' : 'location');
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);

  const totalSteps = (needsPrivacy ? 1 : 0) + (needsLocation ? 1 : 0);
  const stepNo = step === 'privacy' ? 1 : totalSteps;

  function logout() {
    clearToken();
    router.push('/login');
  }

  async function agreePrivacy() {
    setLoading(true);
    try {
      await apiFetch('/auth/privacy-consent', { method: 'POST' });
    } catch {
      // 동의 기록 실패해도 진행은 막지 않는다 — 서버 기록은 법적 근거 보강용이라, 화면 흐름까지
      // 막으면 네트워크 순간 오류로 직원이 앱을 아예 못 쓰게 되는 게 더 문제다.
    } finally {
      setLoading(false);
      if (needsLocation) setStep('location');
      else onComplete();
    }
  }

  async function agreeLocation() {
    setLoading(true);
    setLocError(null);
    try {
      await apiFetch('/auth/location-consent', { method: 'POST' });
    } catch {
      // 위와 동일한 이유로 무시
    }
    const { status } = await getCurrentLocationWithStatus(true);
    setLoading(false);
    if (status === 'OK') {
      onComplete();
    } else {
      setLocError(locationFailureLabel(status));
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15, 17, 24, 0.6)', zIndex: 2000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{ background: '#10162a', color: '#e7ebf5', border: '1px solid #212a45', borderRadius: 16, padding: 28, maxWidth: 440, width: '100%', maxHeight: '86vh', overflowY: 'auto' }}>
        {step === 'privacy' ? (
          <>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#7db0ff', letterSpacing: '0.04em', marginBottom: 4 }}>
              필수 동의 {stepNo}/{totalSteps}
            </div>
            <h2 style={{ marginTop: 0 }}>🔒 개인정보 수집·이용 동의</h2>
            <p style={{ fontSize: 13.5, color: '#9aa5c3', lineHeight: 1.7 }}>
              DSTI-TSB 상황판은 근태관리·공수관리 목적으로 아래 정보를 수집·이용합니다. 서비스 특성상
              이 동의는 필수이며, 동의하지 않으시면 앱을 이용하실 수 없습니다.
            </p>
            <ul style={{ fontSize: 13, color: '#9aa5c3', paddingLeft: 18, lineHeight: 1.9, marginBottom: 16 }}>
              <li><strong>수집 항목:</strong> 이름, 사번, 부서, 출퇴근 시각, 상태 등록 내용(고객사명·업무내용 등), 위치대조 결과(일치/불일치만 — 좌표 원본은 저장하지 않음)</li>
              <li><strong>이용 목적:</strong> 출퇴근·근로시간 관리, 고객사별 공수 집계, 승인/정정 처리</li>
              <li><strong>보유 기간:</strong> 재직기간 + 관계 법령에 따른 보관기간</li>
            </ul>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, marginBottom: 16, cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 'auto', margin: '3px 0 0' }}
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>위 내용을 확인했으며 개인정보 수집·이용에 동의합니다. (필수)</span>
            </label>
            <button disabled={!agreed || loading} onClick={agreePrivacy}>
              {loading ? '처리 중...' : '동의하고 계속'}
            </button>
            <button className="secondary" disabled={loading} onClick={logout}>
              동의하지 않고 로그아웃
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#7db0ff', letterSpacing: '0.04em', marginBottom: 4 }}>
              필수 동의 {stepNo}/{totalSteps}
            </div>
            <h2 style={{ marginTop: 0 }}>📍 위치정보 이용 동의</h2>
            <p style={{ fontSize: 13.5, color: '#9aa5c3', lineHeight: 1.7 }}>
              <strong>고객사미팅 / 고객사작업 / 고객사상주 도착체크, 본사근무 등록</strong> 시, 실제로 그
              위치에서 등록하신 게 맞는지 확인하기 위해 <strong>등록하는 그 순간의 위치정보</strong>를
              확인합니다. 이 동의와 브라우저 위치 권한 허용은 앱 이용에 필수입니다.
            </p>
            <ul style={{ fontSize: 13, color: '#9aa5c3', paddingLeft: 18, lineHeight: 1.9, marginBottom: 16 }}>
              <li>정확한 좌표는 저장하지 않고, <strong>"일치/불일치" 결과만</strong> 남습니다.</li>
              <li>본사근무·재택·휴가 등 위치 확인이 필요없는 상태에서는 위치를 확인하지 않습니다.</li>
              <li>계속 추적하는 게 아니라, 등록 버튼을 누르는 <strong>그 순간에만</strong> 확인합니다.</li>
            </ul>
            {locError && (
              <div style={{ background: 'rgba(239,68,68,0.14)', border: '1px solid #4a1f24', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#f87171', marginBottom: 12, lineHeight: 1.6 }}>
                ⚠ {locError}
                <br />
                브라우저(또는 기기) 설정에서 이 사이트의 위치 권한을 허용한 뒤 다시 시도해주세요.
              </div>
            )}
            <button disabled={loading} onClick={agreeLocation}>
              {loading ? '위치 확인 중...' : locError ? '다시 시도' : '동의하고 위치 권한 허용하기'}
            </button>
            <button className="secondary" disabled={loading} onClick={logout}>
              동의하지 않고 로그아웃
            </button>
          </>
        )}
      </div>
    </div>
  );
}
