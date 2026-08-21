import { useEffect, useState } from 'react';

const DISMISS_KEY = 'installBannerDismissedAt';
const DISMISS_DAYS = 7; // 닫으면 7일간 다시 안 보여줌

function isDismissedRecently(): boolean {
  if (typeof window === 'undefined') return true;
  const raw = window.localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const dismissedAt = Number(raw);
  return Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true;
}

function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export default function InstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isStandalone() || isDismissedRecently()) return;
    setDismissed(false);

    function handleBeforeInstall(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e);
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    if (isIOS()) {
      setShowIOSGuide(true);
    }

    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  function dismiss() {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setDismissed(true);
  }

  async function handleInstallClick() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    dismiss();
  }

  if (dismissed) return null;
  if (!deferredPrompt && !showIOSGuide) return null;

  return (
    <div className="install-banner">
      {deferredPrompt && (
        <>
          <span>📲 이 화면을 앱처럼 설치할 수 있어요</span>
          <button style={{ width: 'auto', margin: 0 }} onClick={handleInstallClick}>지금 설치</button>
        </>
      )}
      {!deferredPrompt && showIOSGuide && (
        <span>📲 아이폰에서는 하단 공유 버튼(⬆️) → <strong>"홈 화면에 추가"</strong>를 누르면 앱처럼 쓸 수 있어요</span>
      )}
      <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={dismiss}>닫기</button>
    </div>
  );
}
