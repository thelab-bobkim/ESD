import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter } from './modules/auth/auth.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { residentRouter } from './modules/resident/resident.routes';
import { nightWorkRouter } from './modules/night-work/night-work.routes';
import { leaveConversionRouter } from './modules/leave-conversion/leave-conversion.routes';
import { approvalRouter } from './modules/approval/approval.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { usersRouter } from './modules/users/users.routes';
import { alertsRouter } from './modules/alerts/alerts.routes';
import { policyRouter } from './modules/policy/policy.routes';
import { pilotRouter } from './modules/pilot/pilot.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { dauofficeRouter } from './modules/dauoffice/dauoffice.routes';

export function createApp() {
  const app = express();

  // 보안 HTTP 헤더 (클릭재킹/MIME스니핑 방지 등)
  app.use(helmet());

  // CORS: CORS_ORIGIN 환경변수에 실제 서비스 도메인을 지정하면 그 출처만 허용한다.
  // 값이 없으면(로컬 개발 등) 전체 허용 — 운영 배포 시 반드시 .env.prod에 CORS_ORIGIN을 설정할 것.
  const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true }));

  app.use(express.json());

  // 전체 API 공통 요청 제한(과도한 요청/기초적인 스크래핑 방지)
  app.use(
    '/api/v1',
    rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false })
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

  app.get('/api/v1/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/attendance', attendanceRouter);
  app.use('/api/v1/resident', residentRouter);
  app.use('/api/v1/night-work', nightWorkRouter);
  app.use('/api/v1/leave-conversion', leaveConversionRouter);
  app.use('/api/v1/approval', approvalRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/alerts', alertsRouter);
  app.use('/api/v1/policy', policyRouter);
  app.use('/api/v1/pilot', pilotRouter);
  app.use('/api/v1/audit', auditRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/dauoffice', dauofficeRouter);

  // 공통 에러 핸들러
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' } });
  });

  return app;
}
