import { Pool } from 'pg';
import { env } from '../config/env.js';
import { runMigrations } from './migrations.js';

if (!env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');

const pool = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000 });

try {
  await runMigrations(pool);
  process.stdout.write('Database migrations are current.\n');
} finally {
  await pool.end();
}
