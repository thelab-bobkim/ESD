import 'dotenv/config';
import { createApp } from './app';

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[employee-status-backend] listening on port ${PORT}`);
});
