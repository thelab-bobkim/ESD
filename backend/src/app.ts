import express from 'express';
import cors from 'cors';
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
  app.use(cors());
  app.use(express.json());

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
