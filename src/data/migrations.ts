import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const lockId = '817435091220';

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const directory = fileURLToPath(new URL('../../database/migrations/', import.meta.url));
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

    for (const version of files) {
      const sql = await readFile(new URL(`../../database/migrations/${version}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (applied.rowCount) {
        if (applied.rows[0]!.checksum !== checksum) throw new Error(`Applied migration '${version}' has changed`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
    } finally {
      client.release();
    }
  }
}
