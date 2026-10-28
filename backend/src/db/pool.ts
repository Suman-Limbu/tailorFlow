import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Configure secure TLS/SSL options for PostgreSQL connections.
 * Enforces certificate verification by default for remote/Supabase connections.
 * Automatically discovers prod-ca-2021.crt in backend/certs/.
 */
function getSslConfig(): pg.ConnectionConfig['ssl'] {
  const isSupabase = env.DATABASE_URL.includes('supabase.co');
  const requireSsl = isSupabase || env.NODE_ENV === 'production' || process.env.DATABASE_SSL === 'true';

  if (!requireSsl) {
    return undefined;
  }

  // Secure default: enforce server certificate verification
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';

  // Search candidate locations for the Supabase Root CA certificate
  const candidateCaPaths = [
    process.env.DATABASE_SSL_CA_PATH,
    path.resolve(__dirname, '..', '..', 'certs', 'prod-ca-2021.crt'),
    path.resolve(process.cwd(), 'certs', 'prod-ca-2021.crt'),
    path.resolve(process.cwd(), 'backend', 'certs', 'prod-ca-2021.crt'),
    path.resolve(process.cwd(), 'prod-ca-2021.crt'),
  ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

  let ca: string | undefined;
  if (candidateCaPaths.length > 0) {
    ca = fs.readFileSync(candidateCaPaths[0], 'utf-8');
  } else if (process.env.DATABASE_SSL_CA) {
    ca = process.env.DATABASE_SSL_CA;
  }

  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
  };
}

function createPool(): pg.Pool | null {
  if (!env.hasDatabaseConfig) {
    return null;
  }

  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: getSslConfig(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

export const pool: pg.Pool | null = createPool();

/**
 * Execute a native SQL query with parameterized inputs.
 */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<R>> {
  if (!pool) {
    throw new Error('Database connection not configured. Please set DATABASE_URL in .env.');
  }
  return pool.query<R>(text, params);
}

export interface ConnectionTestResult {
  ok: boolean;
  timestamp?: string;
  error?: string;
}

/**
 * Test connectivity to the database safely.
 * Returns a sanitized result without exposing credentials, URLs, or internal stack traces.
 */
export async function testConnection(): Promise<ConnectionTestResult> {
  if (!pool) {
    return {
      ok: false,
      error: 'Database configuration is missing',
    };
  }

  try {
    const result = await pool.query<{ current_time: string }>('SELECT NOW() AS current_time;');
    return {
      ok: true,
      timestamp: result.rows[0]?.current_time,
    };
  } catch (err: unknown) {
    // Log safe server-side diagnostics: error name, code, message
    const errorObj = err as { name?: string; code?: string; message?: string };
    console.error('[db connection check failed]:', {
      name: errorObj?.name || 'Error',
      code: errorObj?.code || 'UNKNOWN',
      message: errorObj?.message || 'Database connection error',
    });

    return {
      ok: false,
      error: 'Database connection failed or service unavailable',
    };
  }
}

/**
 * Close the pool gracefully.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
