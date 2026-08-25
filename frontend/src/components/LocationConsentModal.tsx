import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getCurrentLocation } from '@/lib/geolocation';

interface Props {
  onDone: (consented: boolean) => void;
}

export default function LocationConsentModal({ onDone }: Props) {
  const [loading, setLoading] = useState(false);

  async function handleAgree() {
    setLoading(true);
    try {
      await apiFetch('/auth/location-consent', { method: 'POST' });
      // 동의 직후 바로 브라우저 위치권한 창을 띄워서, 다음부터는 다시 안 뜨게 한다.
      await getCurrentLocation();
    } catch {
      // 동의 기록 실패해도 화면은 계속 진행시킨다(치명적이지 않음)
    } finally {
      setLoading(false);
      onDone(true);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 420, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>📍 위치정보 수집 동의</h2>
        <p style={{ fontSize: 14, color: '#495057', lineHeight: 1.6 }}>
          <strong>고객사미팅 / 고객사작업 / 고객사상주 도착체크</strong>를 등록하실 때, 실제로 그 고객사
          위치에서 등록하신 게 맞는지 확인하기 위해 <strong>그 순간의 위치정보</strong>를 확인합니다.
        </p>
        <ul style={{ fontSize: 13, color: '#495057', paddingLeft: 18, lineHeight: 1.8 }}>
          <li>정확한 좌표는 저장하지 않고, <strong>"일치/불일치" 결과만</strong> 남습니다.</li>
          <li>본사근무·재택·휴가 등 다른 상태를 등록할 땐 위치를 확인하지 않습니다.</li>
          <li>계속 추적하는 게 아니라, 등록 버튼을 누르는 <strong>그 순간에만</strong> 확인합니다.</li>
        </ul>
        <button disabled={loading} onClick={handleAgree}>
          {loading ? '처리 중...' : '동의하고 계속하기'}
        </button>
        <button className="secondary" disabled={loading} onClick={() => onDone(false)}>
          나중에 하기 (위치대조 없이 계속 사용)
        </button>
      </div>
    </div>
  );
}
