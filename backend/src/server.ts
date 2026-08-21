import 'dotenv/config';
import { createApp } from './app';
import { startDauofficeScheduler } from './modules/dauoffice/dauoffice-scheduler';
import { startClockInReminderScheduler } from './modules/push/reminder-scheduler';

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[employee-status-backend] listening on port ${PORT}`);
});

startDauofficeScheduler();
startClockInReminderScheduler();
