import { Router, type Request, type Response } from 'express';
import { testConnection } from '../db/pool.js';

export const healthRouter = Router();

/**
 * GET /api/health
 * Checks backend and database availability.
 * - Returns 200 if database connectivity is verified.
 * - Returns 503 if database is unavailable or unconfigured.
 * - Never exposes credentials, connection strings, or internal stack traces.
 */
healthRouter.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const dbResult = await testConnection();

  if (dbResult.ok) {
    res.status(200).json({
      status: 'ok',
      service: 'tailorflow-backend',
      timestamp: new Date().toISOString(),
      database: {
        status: 'connected',
        serverTime: dbResult.timestamp,
      },
    });
    return;
  }

  res.status(503).json({
    status: 'error',
    service: 'tailorflow-backend',
    timestamp: new Date().toISOString(),
    database: {
      status: 'unavailable',
      message: dbResult.error || 'Database unavailable',
    },
  });
});
