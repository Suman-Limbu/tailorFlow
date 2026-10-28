import dotenv from 'dotenv';

// Load .env from backend root
dotenv.config();

export interface EnvConfig {
  PORT: number;
  NODE_ENV: string;
  DATABASE_URL: string;
  CORS_ORIGIN: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  hasDatabaseConfig: boolean;
}

const rawDatabaseUrl = process.env.DATABASE_URL?.trim() || '';
const jwtSecret = process.env.JWT_SECRET?.trim() || 'tailorflow-default-development-secret-key-replace-in-production-2026';

export const env: EnvConfig = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: rawDatabaseUrl,
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  JWT_SECRET: jwtSecret,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
  hasDatabaseConfig: rawDatabaseUrl.length > 0,
};
