import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { tryGetVerifiedUserIdForRateLimit } from './common/guards/auth';

/**
 * rate limit 키용 — 토큰의 userId를 "서명까지 실제로 검증"한 뒤에만 신뢰한다(2026-10-01 보안수정,
 * 신규-1). 예전에는 jwt.decode()로 서명 검증 없이 userId를 읽어서, 위조 토큰(서명 불일치)도 UUID
 * 형식만 맞으면 "로그인한 사용자" 몫인 600회/분 버킷을 받을 수 있었다 — 그 UUID를 요청마다 바꾸면
 * IP당 300회/분이어야 할 전역 한도가 사실상 무제한이 됐다(직접 재현 완료, 검증 보고서 참고).
 * 서명 검증에 실패하면(위조 토큰) null을 돌려주고, 호출부가 IP 키로 폴백해 익명과 동일하게 취급한다.
 * 이 검증은 인증(authn) 자체가 아니다 — 각 라우트의 실제 인가는 여전히 requireAuth가 담당한다.
 */
function userKeyFromAuthHeader(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const id = tryGetVerifiedUserIdForRateLimit(header.slice(7));
  return id && /^[0-9a-f-]{36}$/i.test(id) ? `user:${id}` : null;
}
import { authRouter } from './modules/auth/auth.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { residentRouter } from './modules/resident/resident.routes';
import { nightWorkRouter } from './modules/night-work/night-work.routes';
import { leaveConversionRouter } from './modules/leave-conversion/leave-conversion.routes';
import { attendanceCorrectionRouter } from './modules/attendance-correction/attendance-correction.routes';
import { approvalRouter } from './modules/approval/approval.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { usersRouter } from './modules/users/users.routes';
import { alertsRouter } from './modules/alerts/alerts.routes';
import { policyRouter } from './modules/policy/policy.routes';
import { pilotRouter } from './modules/pilot/pilot.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { dauofficeRouter } from './modules/dauoffice/dauoffice.routes';
import { pushRouter } from './modules/push/push.routes';
import { clientsRouter } from './modules/clients/clients.routes';
import { weatherRouter } from './modules/weather/weather.routes';
import { messagesRouter } from './modules/messages/messages.routes';
import { auditLocationRouter } from './modules/audit-location/audit-location.routes';
import { nightWorkMailRouter } from './modules/night-work-mail/night-work-mail.routes';
import { dailyWorkLogRouter } from './modules/daily-work-log/daily-work-log.routes';
import { projectsRouter } from './modules/projects/projects.routes';

export function createApp() {
  const app = express();

  // nginx가 앞단에서 리버스 프록시로 동작하므로, X-Forwarded-For 헤더의 첫 번째 홉(nginx)만
  // 신뢰하도록 설정한다. 이게 없으면 express-rate-limit이 실제 접속자 IP를 못 믿어 에러를 낸다.
  app.set('trust proxy', 1);

  // 보안 HTTP 헤더 (클릭재킹/MIME스니핑 방지 등)
  app.use(helmet());

  // CORS: CORS_ORIGIN 환경변수에 실제 서비스 도메인을 지정하면 그 출처만 허용한다.
  // 2026-09-30 수정(M-15): 예전엔 값이 없으면 운영에서도 "전체 허용"이었다(fail-open) — .env.prod에서
  // 이 값 하나를 빠뜨리면 아무 사이트나 브라우저 스크립트로 API를 호출할 수 있는 상태가 됐다.
  // 이제 운영(NODE_ENV=production)에서 값이 없으면 "다른 출처는 전부 거부"한다(fail-closed). 이 앱은
  // nginx가 같은 출처로 프론트와 API를 함께 서비스하므로, 같은 출처 요청에는 영향이 없다.
  const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(cors({ origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : !isProduction }));

  // 2026-09-30(M-15): 본문 크기 상한을 명시(기본 100kb와 같지만, 의도를 드러내고 향후 변경을 막기 위함).
  app.use(express.json({ limit: '200kb' }));

  // 전체 API 공통 요청 제한(과도한 요청/기초적인 스크래핑 방지)
  // 2026-09-30 수정(M-15): 예전엔 IP 기준 300회/분이었다 — 사무실 직원 수십 명이 같은 공인 IP(NAT)로
  // 접속하고 관리자 상황판이 15초마다 폴링하면 정상 사용만으로 한도에 걸려 전원이 429를 받을 수 있었다.
  // 로그인한 요청은 "사용자별"(토큰의 userId)로 세고, 로그인 전 요청만 IP로 센다. 사용자당 한도는 넉넉히 둔다.
  app.use(
    '/api/v1',
    rateLimit({
      windowMs: 60_000,
      limit: (req) => (userKeyFromAuthHeader(req) ? 600 : 300),
      keyGenerator: (req) => userKeyFromAuthHeader(req) ?? `ip:${ipKeyGenerator(req.ip ?? '')}`,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // 로그인은 별도로 더 엄격하게 제한(무차별 대입 공격 방지)
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } },
  });
  app.use('/api/v1/auth/login', loginLimiter);
  app.use('/api/v1/auth/register-password', loginLimiter);
  // 2026-09-30 수정(M-7, Claude의 ESD 2.0 검토에서도 동일하게 재발견됨): 비밀번호 셀프 재설정은
  // 로그인보다 더 위험한데(성공하면 비밀번호가 바뀜) 여기만 제한이 빠져 있었다 — 같은 제한을 건다
  // (계정 단위 잠금은 auth.routes.ts에서 별도로 건다).
  app.use('/api/v1/auth/reset-password', loginLimiter);
  // 2026-09-20: "감사인 전용 로그인" — 비번 확인·OTP 확인 두 단계 모두 무차별 대입 대상이라
  // 일반 로그인과 동일한 제한을 건다.
  app.use('/api/v1/auth/audit-login', loginLimiter);
  app.use('/api/v1/auth/audit-login/enroll-confirm', loginLimiter);
  app.use('/api/v1/auth/audit-login/verify', loginLimiter);

  app.get('/api/v1/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/attendance', attendanceRouter);
  app.use('/api/v1/resident', residentRouter);
  app.use('/api/v1/night-work', nightWorkRouter);
  app.use('/api/v1/leave-conversion', leaveConversionRouter);
  app.use('/api/v1/attendance-correction', attendanceCorrectionRouter);
  app.use('/api/v1/approval', approvalRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/alerts', alertsRouter);
  app.use('/api/v1/policy', policyRouter);
  app.use('/api/v1/pilot', pilotRouter);
  app.use('/api/v1/audit', auditRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/dauoffice', dauofficeRouter);
  app.use('/api/v1/push', pushRouter);
  app.use('/api/v1/clients', clientsRouter);
  app.use('/api/v1/weather', weatherRouter);
  app.use('/api/v1/messages', messagesRouter);
  app.use('/api/v1/audit-location', auditLocationRouter);
  app.use('/api/v1/night-work-mail', nightWorkMailRouter);
  app.use('/api/v1/daily-work-log', dailyWorkLogRouter);
  app.use('/api/v1/projects', projectsRouter);

  // 공통 에러 핸들러 — createRouter()가 async 핸들러의 rejection을 next(err)로 넘겨주므로,
  // 라우트 안에서 던져진 예외는 전부 여기로 모인다(2026-09-30 수정 전에는 unhandled rejection이
  // 되어 백엔드 프로세스가 종료됐다).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    // 2026-09-30 수정: express.json()이 던지는 JSON 파싱 실패/용량 초과는 클라이언트 잘못이라
    // 500이 아니라 400으로 돌려준다(예전엔 모든 예외가 일괄 500이었다).
    const type = (err as { type?: string } | null | undefined)?.type;
    if (type === 'entity.parse.failed' || type === 'entity.too.large') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: '요청 본문 형식이 올바르지 않습니다.' } });
    }
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' } });
  });

  return app;
}
