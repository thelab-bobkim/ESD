import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    kakao: any;
  }
}

interface Props {
  initialAddress?: string;
  // 2026-09-30: "위치 불일치 시 카카오맵으로 직접 확인" 흐름(직원이 GPS로 잡힌 본인 위치를 지도에서
  // 확인/보정) 전용 — 텍스트 검색 없이 이 좌표를 바로 지도 중심에 놓고 마커를 찍어둔다. 새 고객사
  // 위치를 찾는 기존 흐름(initialAddress)과 동시에 쓰이지 않는다.
  initialCoords?: { lat: number; lng: number };
  title?: string;
  helpText?: string;
  confirmLabel?: string;
  onSelect: (lat: number, lng: number, address?: string, placeName?: string) => void;
  onClose: () => void;
}

const KAKAO_KEY = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;

function loadKakaoScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.kakao?.maps) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false&libraries=services`;
    script.onload = () => window.kakao.maps.load(() => resolve());
    script.onerror = () => reject(new Error('카카오맵을 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });
}

export default function MapPickerModal({ initialAddress, initialCoords, title, helpText, confirmLabel, onSelect, onClose }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const geocoderRef = useRef<any>(null);
  const [search, setSearch] = useState(initialAddress ?? '');
  const [selected, setSelected] = useState<{ lat: number; lng: number; address?: string; placeName?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!KAKAO_KEY) {
      setError('카카오맵 키가 설정되어 있지 않습니다. 관리자에게 문의하세요.');
      setLoading(false);
      return;
    }
    loadKakaoScript()
      .then(() => {
        if (!mapContainerRef.current) return;
        const map = new window.kakao.maps.Map(mapContainerRef.current, {
          center: initialCoords
            ? new window.kakao.maps.LatLng(initialCoords.lat, initialCoords.lng)
            : new window.kakao.maps.LatLng(37.5665, 126.978),
          level: initialCoords ? 3 : 4,
        });
        mapRef.current = map;
        geocoderRef.current = new window.kakao.maps.services.Geocoder();

        window.kakao.maps.event.addListener(map, 'click', (e: any) => {
          const lat = e.latLng.getLat();
          const lng = e.latLng.getLng();
          // 직접 클릭한 지점은 장소명이 없으니, 역지오코딩으로 주소만 찾아서 같이 저장한다.
          geocoderRef.current.coord2Address(lng, lat, (result: any[], status: string) => {
            const address = status === window.kakao.maps.services.Status.OK
              ? result[0]?.road_address?.address_name || result[0]?.address?.address_name
              : undefined;
            placeMarker(lat, lng, address);
          });
        });

        setLoading(false);
        if (initialCoords) {
          // GPS로 잡힌 좌표를 그대로 마커로 먼저 찍어둔다(직원이 "이 위치가 맞다"고 바로 확정할 수
          // 있게) — 역지오코딩은 표시용 주소만 보완하는 것이라 실패해도 마커는 그대로 유지한다.
          geocoderRef.current.coord2Address(initialCoords.lng, initialCoords.lat, (result: any[], status: string) => {
            const address = status === window.kakao.maps.services.Status.OK
              ? result[0]?.road_address?.address_name || result[0]?.address?.address_name
              : undefined;
            placeMarker(initialCoords.lat, initialCoords.lng, address);
          });
        } else if (initialAddress) {
          doSearch(initialAddress, map);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : '지도를 불러오지 못했습니다.');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function placeMarker(lat: number, lng: number, address?: string, placeName?: string) {
    const map = mapRef.current;
    if (!map) return;
    const position = new window.kakao.maps.LatLng(lat, lng);
    if (markerRef.current) {
      markerRef.current.setPosition(position);
    } else {
      markerRef.current = new window.kakao.maps.Marker({ position, map });
    }
    map.setCenter(position);
    setSelected({ lat, lng, address, placeName });
  }

  function doSearch(keyword?: string, mapOverride?: any) {
    const map = mapOverride ?? mapRef.current;
    const q = keyword ?? search;
    if (!q.trim() || !window.kakao?.maps?.services) return;
    const places = new window.kakao.maps.services.Places();
    places.keywordSearch(q, (data: any[], status: string) => {
      if (status === window.kakao.maps.services.Status.OK && data.length > 0) {
        const { y, x, place_name: placeName, road_address_name: roadAddress, address_name: address } = data[0];
        placeMarker(Number(y), Number(x), roadAddress || address, placeName);
        map?.setLevel(3);
      } else {
        setError('검색 결과가 없습니다. 지도를 클릭해서 직접 위치를 찍어주세요.');
      }
    });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 20, maxWidth: 640, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>{title ?? '🗺️ 지도에서 고객사 위치 찾기'}</h2>
        {error && <div className="error">{error}</div>}
        {!initialCoords && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input
              style={{ margin: 0, flex: 1 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="고객사명 또는 주소 검색"
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button style={{ width: 'auto', margin: 0 }} onClick={() => doSearch()}>검색</button>
          </div>
        )}
        {loading && <div className="board-empty">지도를 불러오는 중...</div>}
        <div ref={mapContainerRef} style={{ width: '100%', height: 360, borderRadius: 10, background: '#eee' }} />
        {selected && (
          <div style={{ fontSize: 13, color: '#1c1f24', marginTop: 8, padding: '8px 10px', background: '#f5f6f8', borderRadius: 8 }}>
            📍 {selected.placeName && <strong>{selected.placeName}</strong>}
            {selected.placeName && selected.address ? ' · ' : ''}
            {selected.address || (!selected.placeName ? '주소를 찾지 못했습니다(좌표만 저장됩니다)' : '')}
          </div>
        )}
        <p style={{ fontSize: 12, color: '#868e96', marginTop: 8 }}>
          {helpText ?? '검색 후 정확한 위치가 아니면 지도를 클릭해서 직접 위치를 찍어주세요.'}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button disabled={!selected} onClick={() => selected && onSelect(selected.lat, selected.lng, selected.address, selected.placeName)}>
            {confirmLabel ?? '이 위치로 저장'}
          </button>
          <button className="secondary" onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}
