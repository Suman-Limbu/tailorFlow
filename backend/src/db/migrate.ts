import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { pool, closePool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Distinct 32-bit integer identifier for TailorFlow migration advisory lock
const MIGRATION_LOCK_ID = 74110825;

/**
 * Resolves the directory containing .sql migration files.
 * Handles both development (tsx running from src/) and production (node running from dist/).
 */
function resolveMigrationsDir(): string {
  const candidatePaths = [
    // 1. Direct path when running in TypeScript source (e.g. tsx src/db/migrate.ts)
    path.resolve(__dirname, 'migrations'),
    // 2. Explicit source path when running compiled code from dist/ (dist/db/migrate.js -> src/db/migrations)
    path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
    // 3. Anchored path relative to current working directory
    path.resolve(process.cwd(), 'src', 'db', 'migrations'),
    // 4. Candidate backend root migrations directory
    path.resolve(process.cwd(), 'migrations'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: create default migrations directory in src/db/migrations
  const defaultDir = path.resolve(process.cwd(), 'src', 'db', 'migrations');
  fs.mkdirSync(defaultDir, { recursive: true });
  return defaultDir;
}

async function runMigrations(): Promise<void> {
  if (!env.hasDatabaseConfig || !pool) {
    console.error('[migrate] Error: DATABASE_URL is not set. Please configure .env before running migrations.');
    process.exit(1);
  }

  const migrationsDir = resolveMigrationsDir();
  console.log(`[migrate] Using migrations directory: ${migrationsDir}`);

  console.log('[migrate] Connecting to database...');
  const client = await pool.connect();

  let lockAcquired = false;
  let activeError: unknown = null;

  try {
    // Acquire PostgreSQL session-level advisory lock to prevent concurrent migration execution
    console.log('[migrate] Acquiring advisory lock...');
    await client.query('SELECT pg_advisory_lock($1);', [MIGRATION_LOCK_ID]);
    lockAcquired = true;

    // Create migration tracking table if it does not already exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Retrieve already applied migrations
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY id ASC;'
    );
    const appliedSet = new Set(rows.map((r) => r.name));

    // Sort migration files using natural numeric order (e.g. 1, 2, 10 or 001, 002)
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const pendingFiles = files.filter((file) => !appliedSet.has(file));

    if (pendingFiles.length === 0) {
      console.log('[migrate] Database is up to date. No pending migrations.');
      return;
    }

    console.log(`[migrate] Found ${pendingFiles.length} pending migration(s).`);

    // Apply each pending migration in an isolated transaction
    for (const file of pendingFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`[migrate] Applying: ${file}...`);
      await client.query('BEGIN');
      try {
        // Execute migration SQL commands
        await client.query(sql);

        // Record migration in tracking table with parameterized input
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1);',
          [file]
        );

        await client.query('COMMIT');
        console.log(`[migrate] Successfully applied: ${file}`);
      } catch (migrationError) {
        // Attempt rollback; catch and log rollback failure without swallowing migrationError
        try {
          await client.query('ROLLBACK');
          console.error(`[migrate] Transaction rolled back for ${file}.`);
        } catch (rollbackError) {
          console.error(
            `[migrate] Warning: ROLLBACK failed for ${file}:`,
            rollbackError instanceof Error ? rollbackError.message : rollbackError
          );
        }
        throw migrationError;
      }
    }

    console.log('[migrate] All pending migrations successfully applied.');
  } catch (err) {
    activeError = err;
    throw err;
  } finally {
    // Release advisory lock safely without masking any active migration error
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1);', [MIGRATION_LOCK_ID]);
        console.log('[migrate] Advisory lock released.');
      } catch (unlockError) {
        if (activeError) {
          console.error(
            '[migrate] Warning: Failed to release advisory lock during error cleanup:',
            unlockError instanceof Error ? unlockError.message : unlockError
          );
        } else {
          throw unlockError;
        }
      }
    }

    // Release database client safely back to pool
    try {
      client.release();
    } catch (releaseError) {
      console.error(
        '[migrate] Warning: Failed to release database client:',
        releaseError instanceof Error ? releaseError.message : releaseError
      );
    }

    // Close pool cleanly
    try {
      await closePool();
    } catch (closeError) {
      console.error(
        '[migrate] Warning: Failed to close database pool:',
        closeError instanceof Error ? closeError.message : closeError
      );
    }
  }
}

runMigrations().catch((err) => {
  console.error('[migrate] Migration process failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
