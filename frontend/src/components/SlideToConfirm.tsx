import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  /** 밀기를 완료했을 때 실행. false를 반환(또는 reject)하면 확정 취소하고 손잡이를 원위치로 되돌린다
   * (예: 아직 조기퇴근 사유를 안 입력한 경우) — 그 외(undefined/true)는 확정 처리된다. */
  onConfirm: () => void | boolean | Promise<void | boolean>;
  label?: string;
  /** 팝업이 뜬 직후 이 시간(ms) 동안은 밀어도 반응하지 않는다 — 가방/주머니 속에서 화면을 열자마자
   * 연속으로 터치되는 경우 첫 터치만으로 확정되는 사고를 막기 위한 지연(2026-09-16, 오터치 방지 요청). */
  readyDelayMs?: number;
  /** 부모가 강제로 비활성화하고 싶을 때(예: 위치 이상치 감지, 다른 처리 진행 중). */
  disabled?: boolean;
  disabledHint?: string;
}

const TRACK_HEIGHT = 48;
const HANDLE_SIZE = 40;
const HANDLE_MARGIN = 4;

/**
 * "아이콘 오터치(가방/주머니 속 터치 등)"로 상태가 잘못 확정되는 사고를 줄이기 위한 슬라이더형
 * 확인 컨트롤. 단순 탭 버튼과 달리 (1) 뜬 직후 짧은 지연 동안 비활성 상태를 거치고, (2) 끝까지
 * 밀어야만 확정되므로, 스치듯 닿는 터치 한 번으로는 절대 확정되지 않는다. 취소는 이 컨트롤이
 * 아니라 별도의 일반 버튼으로 처리한다(취소까지 어렵게 만들 필요는 없음).
 */
export default function SlideToConfirm({ onConfirm, label = '밀어서 확정', readyDelayMs = 900, disabled, disabledHint }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const startClientXRef = useRef(0);
  const startDragXRef = useRef(0);

  // 뜰 때마다(부모가 이 컴포넌트를 새로 마운트할 때마다) 지연부터 다시 시작한다.
  useEffect(() => {
    setReady(false);
    setConfirmed(false);
    setDragX(0);
    const t = setTimeout(() => setReady(true), readyDelayMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyDelayMs]);

  function maxDragX(): number {
    const track = trackRef.current;
    if (!track) return 0;
    return Math.max(0, track.clientWidth - HANDLE_SIZE - HANDLE_MARGIN * 2);
  }

  function canDrag(): boolean {
    return ready && !disabled && !busy && !confirmed;
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canDrag()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    startClientXRef.current = e.clientX;
    startDragXRef.current = dragX;
    setDragging(true);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || pointerIdRef.current !== e.pointerId) return;
    const delta = e.clientX - startClientXRef.current;
    const next = Math.min(maxDragX(), Math.max(0, startDragXRef.current + delta));
    setDragX(next);
  }

  async function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    const max = maxDragX();
    if (max <= 0 || dragX < max * 0.88) {
      setDragX(0);
      return;
    }
    setDragX(max);
    setBusy(true);
    try {
      const result = await onConfirm();
      if (result === false) {
        setDragX(0);
      } else {
        setConfirmed(true);
      }
    } catch {
      setDragX(0);
    } finally {
      setBusy(false);
    }
  }

  const trackBg = confirmed ? 'rgba(34,197,94,0.18)' : !ready || disabled ? '#151c34' : '#0d1326';
  const trackBorder = confirmed ? '#1f4a2e' : !ready || disabled ? '#212a45' : '#2f6feb';
  const handleBg = confirmed ? '#2f9e44' : !ready || disabled || busy ? '#374162' : '#2f6feb';

  let text = `→ ${label}`;
  if (!ready) text = '잠시만요...';
  else if (disabled) text = disabledHint ?? '지금은 밀 수 없어요';
  else if (busy) text = '처리 중...';
  else if (confirmed) text = '확정되었습니다 ✓';

  return (
    <div
      ref={trackRef}
      style={{
        position: 'relative', height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2,
        background: trackBg, border: `1px solid ${trackBorder}`,
        overflow: 'hidden', userSelect: 'none', touchAction: 'pan-y', width: '100%',
        opacity: disabled && !confirmed ? 0.75 : 1,
      }}
    >
      <div
        style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600, color: !ready ? '#6b7594' : confirmed ? '#4ade80' : '#9aa5c3',
          pointerEvents: 'none',
        }}
      >
        {text}
      </div>
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: 'absolute', top: HANDLE_MARGIN, left: HANDLE_MARGIN, width: HANDLE_SIZE, height: HANDLE_SIZE,
          borderRadius: '50%', background: handleBg,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          transform: `translateX(${dragX}px)`,
          transition: dragging ? 'none' : 'transform 0.2s ease, background 0.2s ease',
          cursor: canDrag() ? 'grab' : 'default',
          touchAction: 'none',
        }}
      >
        {confirmed ? '✓' : busy ? '…' : '👉'}
      </div>
    </div>
  );
}
