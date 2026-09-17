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
const CONFIRM_RATIO = 0.85;

/**
 * "아이콘 오터치(가방/주머니 속 터치 등)"로 상태가 잘못 확정되는 사고를 줄이기 위한 슬라이더형
 * 확인 컨트롤. 단순 탭 버튼과 달리 (1) 뜬 직후 짧은 지연 동안 비활성 상태를 거치고, (2) 끝까지
 * 밀어야만 확정되므로, 스치듯 닿는 터치 한 번으로는 절대 확정되지 않는다. 취소는 이 컨트롤이
 * 아니라 별도의 일반 버튼으로 처리한다(취소까지 어렵게 만들 필요는 없음).
 *
 * 2026-09-17: 김유범님 "밀어서 퇴근이 반복해도 안 찍힌다" 신고로 발견된 문제를 수정 — 처음 버전은
 * 지름 40px짜리 손잡이(원)를 정확히 짚어서 끌어야만 드래그가 시작됐는데, 실제 현장에서 급하게
 * 화면을 정확히 안 보고 미는 경우 손잡이를 비껴가서 트랙(막대) 아무 곳이나 밀면 반응이 전혀
 * 없었던 게 원인으로 추정된다. 지금은 트랙 전체 어디를 짚어도 그 지점에서 바로 드래그가 시작되고
 * 손잡이가 손가락 위치로 즉시 이동한 뒤 따라간다 — 실제 "밀어서 잠금해제" UI들과 같은 방식이라
 * 훨씬 관대하다. 또한 pointerup 시점에 React state(dragX)의 클로저 지연 가능성을 없애기 위해
 * ref(dragXRef)로 최신값을 별도로 들고 있다가 그 값으로 판정한다.
 */
export default function SlideToConfirm({ onConfirm, label = '밀어서 확정', readyDelayMs = 900, disabled, disabledHint }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [dragX, setDragX] = useState(0);
  // pointerup 핸들러가 항상 "지금 이 순간의" 값을 읽도록, state와 별개로 ref에도 동기적으로 반영한다.
  const dragXRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const pointerIdRef = useRef<number | null>(null);

  // 뜰 때마다(부모가 이 컴포넌트를 새로 마운트할 때마다) 지연부터 다시 시작한다.
  useEffect(() => {
    setReady(false);
    setConfirmed(false);
    setDragX(0);
    dragXRef.current = 0;
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

  function setDrag(x: number) {
    dragXRef.current = x;
    setDragX(x);
  }

  // 짚은 지점(clientX)을 트랙 기준 손잡이 위치로 환산 — 손잡이 중심이 손가락 아래에 오도록 보정한다.
  function posFromClientX(clientX: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const raw = clientX - rect.left - HANDLE_SIZE / 2;
    return Math.min(maxDragX(), Math.max(0, raw));
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canDrag()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    setDrag(posFromClientX(e.clientX));
    setDragging(true);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || pointerIdRef.current !== e.pointerId) return;
    setDrag(posFromClientX(e.clientX));
  }

  async function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    const max = maxDragX();
    const current = dragXRef.current;
    if (max <= 0 || current < max * CONFIRM_RATIO) {
      setDrag(0);
      return;
    }
    setDrag(max);
    setBusy(true);
    try {
      const result = await onConfirm();
      if (result === false) {
        setDrag(0);
      } else {
        setConfirmed(true);
      }
    } catch {
      setDrag(0);
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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: 'relative', height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2,
        background: trackBg, border: `1px solid ${trackBorder}`,
        // 트랙 전체를 드래그 대상으로 삼았으므로, 브라우저가 세로 스크롤/줌 제스처로 가로채지
        // 못하게 이 영역 전체의 기본 터치 동작을 꺼둔다(2026-09-17 — 이전엔 손잡이에만 적용돼서
        // 트랙의 나머지 부분을 짚으면 애초에 드래그 시작 이벤트 자체가 씹혔을 수 있다).
        overflow: 'hidden', userSelect: 'none', touchAction: 'none', width: '100%',
        opacity: disabled && !confirmed ? 0.75 : 1,
        cursor: canDrag() ? 'grab' : 'default',
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
        style={{
          position: 'absolute', top: HANDLE_MARGIN, left: HANDLE_MARGIN, width: HANDLE_SIZE, height: HANDLE_SIZE,
          borderRadius: '50%', background: handleBg,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          transform: `translateX(${dragX}px)`,
          transition: dragging ? 'none' : 'transform 0.2s ease, background 0.2s ease',
          pointerEvents: 'none',
        }}
      >
        {confirmed ? '✓' : busy ? '…' : '👉'}
      </div>
    </div>
  );
}
