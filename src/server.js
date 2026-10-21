import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, store } = await createApp(config);

const server = app.listen(config.port, () => {
  console.log(`Classroom Blast is running at http://localhost:${config.port}`);
});

// Let any pending save finish before the process exits.
async function shutdown() {
  server.close();
  await store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
