import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { customerRouter } from './routes/customers.js';
import { orderRouter } from './routes/orders.js';

export const app: Express = express();

// Middlewares
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());

// API Routes
app.use('/api', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/customers', customerRouter);
app.use('/api/orders', orderRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found',
  });
});

// Generic sanitized error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Log server-side only
  console.error('[server error]', err.message || err);

  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
});
