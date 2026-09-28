import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { OperatorSessionRecord } from './repository.js';
import { PostgresSupportRepository } from './postgres-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

function hash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

postgresDescribe('PostgreSQL repository', () => {
  let cleanup: Pool | undefined;
  let repository: PostgresSupportRepository;
  let ticketIds: string[] = [];
  let sessionHashes: string[] = [];
  let attemptKeys: string[] = [];

  beforeAll(async () => {
    cleanup = new Pool({ connectionString: databaseUrl!, max: 2 });
    const check = new PostgresSupportRepository(databaseUrl!);
    await check.health();
    await check.close();
  });

  beforeEach(() => {
    repository = new PostgresSupportRepository(databaseUrl!);
    ticketIds = [];
    sessionHashes = [];
    attemptKeys = [];
  });

  afterEach(async () => {
    await repository.close();
    if (!cleanup) return;

    if (ticketIds.length) {
      await cleanup.query('DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])', [ticketIds]);
      await cleanup.query('DELETE FROM tickets WHERE id = ANY($1::text[])', [ticketIds]);
    }
    if (sessionHashes.length) {
      await cleanup.query('DELETE FROM operator_sessions WHERE session_hash = ANY($1::text[])', [sessionHashes]);
    }
    if (attemptKeys.length) {
      await cleanup.query('DELETE FROM auth_login_attempts WHERE attempt_key = ANY($1::text[])', [attemptKeys]);
    }
  });

  afterAll(async () => {
    await cleanup?.end();
  });

  it('keeps tickets and audit entries after reconnecting', async () => {
    const created = await repository.createTicket({
      customerId: 'cust_acme_corp',
      subject: `Postgres integration ${randomUUID()}`,
      rawMessage: 'Please check the latest invoice.',
    });
    ticketIds.push(created.id);

    const audit = await cleanup!.query<{ actor: string; action_type: string; details: Record<string, unknown> }>(
      'SELECT actor, action_type, details FROM audit_logs WHERE entity_id = $1',
      [created.id]
    );
    await repository.close();
    repository = new PostgresSupportRepository(databaseUrl!);

    expect(await repository.getTicket(created.id)).toMatchObject(created);
    expect(audit.rows).toEqual([{
      actor: 'SYSTEM',
      action_type: 'TICKET_CREATED',
      details: { customerId: 'cust_acme_corp' },
    }]);
  });

  it('persists a session and revokes it when deleted', async () => {
    const session: OperatorSessionRecord = {
      sessionHash: hash(),
      operatorId: 'integration-agent',
      credentialHash: hash(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    sessionHashes.push(session.sessionHash);

    await repository.createOperatorSession(session);
    await repository.close();
    repository = new PostgresSupportRepository(databaseUrl!);

    expect(await repository.getOperatorSession(session.sessionHash)).toEqual(session);
    await repository.deleteOperatorSession(session.sessionHash);
    expect(await repository.getOperatorSession(session.sessionHash)).toBeNull();
  });

  it('counts concurrent login attempts once and keeps the limit across reconnects', async () => {
    const key = hash();
    attemptKeys.push(key);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => repository.consumeLoginAttempt(key, 60, 5))
    );
    await repository.close();
    repository = new PostgresSupportRepository(databaseUrl!);
    const blocked = await repository.consumeLoginAttempt(key, 60, 5);

    expect(results.filter(({ allowed }) => allowed)).toHaveLength(5);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(7);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    await repository.clearLoginAttempts(key);
    expect(await repository.consumeLoginAttempt(key, 60, 5)).toMatchObject({ allowed: true });
  });
});
