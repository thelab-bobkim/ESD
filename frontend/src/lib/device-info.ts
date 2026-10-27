/** 2026-10-27: 위치 예외 등록 분석용 — 브라우저가 알려주는 범위의 기기 정보(모델명·통신 종류·화면 크기). 실패해도 빈 값으로 넘어간다. */
export async function collectDeviceInfo(): Promise<{ uaModel: string; platformVersion: string; connectionType: string; downlinkMbps: number | null; screen: string }> {
  const out = { uaModel: '', platformVersion: '', connectionType: '', downlinkMbps: null as number | null, screen: '' };
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : {}) as any;
    try {
      const uad = nav.userAgentData;
      if (uad && typeof uad.getHighEntropyValues === 'function') {
        const v = await uad.getHighEntropyValues(['model', 'platformVersion']);
        out.uaModel = String(v?.model ?? '');
        out.platformVersion = String(v?.platformVersion ?? '');
      }
    } catch { /* 모델명은 없을 수 있다 */ }
    const c = nav.connection;
    if (c) {
      out.connectionType = String(c.effectiveType ?? c.type ?? '');
      if (typeof c.downlink === 'number') out.downlinkMbps = c.downlink;
    }
    if (typeof window !== 'undefined' && window.screen) out.screen = `${window.screen.width}x${window.screen.height}`;
  } catch { /* 무시 */ }
  return out;
}
