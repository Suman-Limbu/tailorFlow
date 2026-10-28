import { app } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';

const server = app.listen(env.PORT, () => {
  console.log(`[server] TailorFlow backend running on port ${env.PORT} in ${env.NODE_ENV} mode.`);
  if (env.hasDatabaseConfig) {
    console.log('[server] DATABASE_URL is configured. Connectivity check active via /api/health.');
  } else {
    console.log('[server] DATABASE_URL is not configured yet. Server is running; /api/health will report 503 until configured.');
  }
});

// Graceful shutdown
async function handleShutdown(signal: string) {
  console.log(`[server] Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    await closePool();
    console.log('[server] HTTP server closed and database pool terminated.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

