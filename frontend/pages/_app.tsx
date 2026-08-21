import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import '../styles/globals.css';
import InstallBanner from '@/components/InstallBanner';

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // 서비스워커 등록 실패는 치명적이지 않음(홈 화면 추가는 계속 가능)
      });
    }
  }, []);

  return (
    <>
      <InstallBanner />
      <Component {...pageProps} />
    </>
  );
}
