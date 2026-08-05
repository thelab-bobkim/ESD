import https from 'https';
import { URL } from 'url';
import { prisma } from '../../common/prisma';

/**
 * 다우오피스 OpenAPI 클라이언트.
 * AMS(thelab-bobkim/AMS)의 backend/dauoffice_api.py 를 TypeScript로 이식했다.
 * - OAuth2 client_credentials 인증 (Basic 헤더로 토큰 발급)
 * - 발급받은 토큰은 DB(DauofficeToken)에 캐시하여 재사용
 * - 401 응답 시 토큰 재발급 후 1회 재시도
 */

export interface DauofficeUserGroup {
  type?: string;
  name?: string;
}

export interface DauofficeEmployee {
  loginId: string;
  name: string;
  status: string; // 'NORMAL'만 재직중인 유효 계정
  userGroups?: DauofficeUserGroup[];
  positionName?: string;
  employeeNumber?: string;
}

export interface DauofficeAttendanceElement {
  loginId?: string;
  accrualDate?: string; // 'YYYY-MM-DD'
  startWorkTime?: string; // 'YYYY-MM-DD HH:MM:SS'
}

interface RawResponse {
  status: number;
  json: any;
}

function requestJson(
  method: string,
  urlStr: string,
  opts: { headers?: Record<string, string>; body?: string; insecureTls?: boolean } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        port: url.port || 443,
        headers: opts.headers,
        // AMS 원본(Python requests)은 verify=False로 TLS 검증을 껐다.
        // ESD는 기본값을 안전하게(검증 ON) 두고, 필요할 때만 DAUOFFICE_TLS_INSECURE=true로 끄도록 한다.
        rejectUnauthorized: !opts.insecureTls,
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode || 0, json: null });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DauofficeAPI 요청 타임아웃')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

interface DauofficeConfig {
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  insecureTls: boolean;
}

function loadConfig(): DauofficeConfig {
  return {
    clientId: process.env.DAUOFFICE_CLIENT_ID || '',
    clientSecret: process.env.DAUOFFICE_CLIENT_SECRET || '',
    apiUrl: process.env.DAUOFFICE_API_URL || 'https://api.daouoffice.com',
    insecureTls: process.env.DAUOFFICE_TLS_INSECURE === 'true',
  };
}

export class DauofficeClient {
  private cfg = loadConfig();
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  private basicAuthHeader(): string {
    const credentials = `${this.cfg.clientId}:${this.cfg.clientSecret}`;
    return `Basic ${Buffer.from(credentials, 'utf-8').toString('base64')}`;
  }

  isConfigured(): boolean {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret);
  }

  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && this.tokenExpiresAt && new Date() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const cached = await prisma.dauofficeToken.findFirst({ orderBy: { createdAt: 'desc' } });
    if (cached && new Date() < cached.expiresAt) {
      this.accessToken = cached.accessToken;
      this.tokenExpiresAt = cached.expiresAt;
      return this.accessToken;
    }
    return this.issueNewToken();
  }

  private async issueNewToken(): Promise<string | null> {
    if (!this.isConfigured()) {
      // eslint-disable-next-line no-console
      console.warn('[DauofficeClient] DAUOFFICE_CLIENT_ID/SECRET이 설정되지 않았습니다.');
      return null;
    }
    const url = `${this.cfg.apiUrl}/public/auth/v1/oauth2/token`;
    const res = await requestJson('POST', url, {
      headers: { Authorization: this.basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      insecureTls: this.cfg.insecureTls,
    });
    if (res.status === 200 && res.json?.access_token) {
      this.accessToken = res.json.access_token;
      const expiresIn = Number(res.json.expires_in ?? 86400);
      this.tokenExpiresAt = new Date(Date.now() + (expiresIn - 300) * 1000);
      try {
        await prisma.dauofficeToken.create({
          data: { accessToken: this.accessToken as string, expiresAt: this.tokenExpiresAt },
        });
      } catch {
        // 캐시 저장 실패는 치명적이지 않으므로 무시(다음 호출에서 재발급)
      }
      return this.accessToken;
    }
    // eslint-disable-next-line no-console
    console.warn(`[DauofficeClient] 토큰 발급 실패: status=${res.status}`);
    return null;
  }

  private async makeRequest(
    method: string,
    endpoint: string,
    params?: Record<string, string | number>,
    retry = true
  ): Promise<RawResponse | null> {
    const token = await this.getAccessToken();
    if (!token) return null;
    const query = params
      ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString()
      : '';
    const url = `${this.cfg.apiUrl}${endpoint}${query}`;
    const res = await requestJson(method, url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      insecureTls: this.cfg.insecureTls,
    });
    if (res.status === 401 && retry) {
      this.accessToken = null;
      this.tokenExpiresAt = null;
      await this.issueNewToken();
      return this.makeRequest(method, endpoint, params, false);
    }
    return res;
  }

  /** 조직도(직원 목록) 조회 */
  async getOrganizationInfo(): Promise<DauofficeEmployee[]> {
    const res = await this.makeRequest('GET', '/public/api/attnd-v3/organization-chart/user/list');
    if (!res || res.status !== 200) return [];
    if (String(res.json?.code ?? '') === '200') {
      return (res.json.data ?? []) as DauofficeEmployee[];
    }
    return [];
  }

  /** 기간별 근태(출근) 기록 조회 (페이지네이션) */
  async getAttendanceRecords(
    startDate: string,
    endDate: string,
    page = 0,
    pageSize = 50
  ): Promise<{ totalCount: number; elements: DauofficeAttendanceElement[]; totalPages: number }> {
    const res = await this.makeRequest('GET', '/public/api/attnd-v2/attnd', { startDate, endDate, page, pageSize });
    if (!res || res.status !== 200 || String(res.json?.code ?? '') !== '200') {
      return { totalCount: 0, elements: [], totalPages: 0 };
    }
    const raw = res.json.data ?? {};
    const pageInfo = raw.page ?? {};
    return {
      totalCount: pageInfo.totalCount ?? 0,
      elements: raw.elements ?? [],
      totalPages: pageInfo.totalPages ?? 1,
    };
  }
}
