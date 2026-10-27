/** 2026-10-27: 위치 예외 등록 분석용 — User-Agent 문자열에서 OS/브라우저/기기 모델을 대략 뽑는다(모델명은 브라우저가 알려주는 범위만). */
export type ParsedUa = { os: string; osVersion: string; browser: string; model: string };

export function parseUserAgent(ua: string): ParsedUa {
  const s = ua || '';
  let os = '기타';
  let osVersion = '';
  let model = '';
  let m: RegExpMatchArray | null;
  if ((m = s.match(/Android\s([\d.]+)(?:;\s*([^;)]+))?/))) {
    os = 'Android';
    osVersion = m[1];
    model = (m[2] ?? '').replace(/\s*Build\/.*$/, '').trim();
  } else if ((m = s.match(/iPhone OS ([\d_]+)/))) {
    os = 'iOS';
    osVersion = m[1].replace(/_/g, '.');
    model = 'iPhone';
  } else if ((m = s.match(/iPad.*OS ([\d_]+)/))) {
    os = 'iPadOS';
    osVersion = m[1].replace(/_/g, '.');
    model = 'iPad';
  } else if ((m = s.match(/Windows NT ([\d.]+)/))) {
    os = 'Windows';
    osVersion = m[1];
  } else if ((m = s.match(/Mac OS X ([\d_]+)/))) {
    os = 'macOS';
    osVersion = m[1].replace(/_/g, '.');
  } else if (/Linux/.test(s)) {
    os = 'Linux';
  }
  let browser = '기타';
  if (/SamsungBrowser\/([\d.]+)/.test(s)) browser = '삼성인터넷 ' + (s.match(/SamsungBrowser\/([\d.]+)/)?.[1] ?? '');
  else if (/Whale\/([\d.]+)/.test(s)) browser = '네이버웨일 ' + (s.match(/Whale\/([\d.]+)/)?.[1] ?? '');
  else if (/KAKAOTALK/i.test(s)) browser = '카카오톡 인앱';
  else if (/NAVER\(/i.test(s)) browser = '네이버앱 인앱';
  else if (/Edg\/([\d.]+)/.test(s)) browser = 'Edge ' + (s.match(/Edg\/([\d.]+)/)?.[1] ?? '');
  else if (/(?:Chrome|CriOS)\/([\d.]+)/.test(s)) browser = 'Chrome ' + (s.match(/(?:Chrome|CriOS)\/([\d.]+)/)?.[1] ?? '');
  else if (/(?:Firefox|FxiOS)\/([\d.]+)/.test(s)) browser = 'Firefox ' + (s.match(/(?:Firefox|FxiOS)\/([\d.]+)/)?.[1] ?? '');
  else if (/Safari\/([\d.]+)/.test(s)) browser = 'Safari';
  return { os, osVersion, browser: browser.trim(), model };
}

export type DeviceInfo = { uaModel: string; platformVersion: string; connectionType: string; downlinkMbps: number | null; screen: string };

/** 화면이 보낸 deviceInfo를 길이 제한을 두고 안전하게 정리한다(없으면 빈 값). */
export function sanitizeDeviceInfo(raw: unknown): DeviceInfo {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const dl = typeof o.downlinkMbps === 'number' && Number.isFinite(o.downlinkMbps) ? o.downlinkMbps : null;
  return {
    uaModel: str(o.uaModel, 80),
    platformVersion: str(o.platformVersion, 40),
    connectionType: str(o.connectionType, 20),
    downlinkMbps: dl,
    screen: str(o.screen, 20),
  };
}
