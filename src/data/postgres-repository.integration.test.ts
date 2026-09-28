import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ApprovalRequiredError, IdempotencyConflictError, PolicyMismatchError } from '../core/errors.js';
import type { OperatorSessionRecord } from './repository.js';
import { PostgresSupportRepository } from './postgres-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

interface RefundCase {
  customerId: string;
  invoiceId: string;
  ticketId: string;
}

function hash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

function idempotencyKey(label: string): string {
  return `${label}-${randomUUID()}`;
}

function refundProposalInput(supportCase: RefundCase, key: string, amountCents = 2900) {
  return {
    ticketId: supportCase.ticketId,
    invoiceId: supportCase.invoiceId,
    policyId: 'POL-REFUND-STANDARD',
    amountCents,
    idempotencyKey: key,
  };
}

postgresDescribe('PostgreSQL repository', () => {
  let cleanup: Pool | undefined;
  let repository: PostgresSupportRepository;
  let ticketIds: string[] = [];
  let customerIds: string[] = [];
  let invoiceIds: string[] = [];
  let sessionHashes: string[] = [];
  let attemptKeys: string[] = [];
  let idempotencyKeys: string[] = [];

  beforeAll(async () => {
    cleanup = new Pool({ connectionString: databaseUrl!, max: 2 });
    const check = new PostgresSupportRepository(databaseUrl!);
    await check.health();
    await check.close();
  });

  beforeEach(() => {
    repository = new PostgresSupportRepository(databaseUrl!);
    ticketIds = [];
    customerIds = [];
    invoiceIds = [];
    sessionHashes = [];
    attemptKeys = [];
    idempotencyKeys = [];
  });

  afterEach(async () => {
    await repository.close();
    if (!cleanup) return;

    if (ticketIds.length) {
      await cleanup.query(
        `DELETE FROM audit_logs
         WHERE entity_id = ANY($1::text[])
            OR entity_id IN (SELECT id FROM action_proposals WHERE ticket_id = ANY($1::text[]))`,
        [ticketIds]
      );
      await cleanup.query('DELETE FROM action_proposals WHERE ticket_id = ANY($1::text[])', [ticketIds]);
      await cleanup.query('DELETE FROM tickets WHERE id = ANY($1::text[])', [ticketIds]);
    }
    if (idempotencyKeys.length) {
      await cleanup.query('DELETE FROM idempotency_records WHERE key = ANY($1::text[])', [idempotencyKeys]);
    }
    if (invoiceIds.length) {
      await cleanup.query('DELETE FROM invoices WHERE id = ANY($1::text[])', [invoiceIds]);
    }
    if (customerIds.length) {
      await cleanup.query('DELETE FROM customers WHERE id = ANY($1::text[])', [customerIds]);
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

  async function createRefundCase() {
    const suffix = randomUUID();
    const customerId = `cust_it_${suffix}`;
    const invoiceId = `invoice_it_${suffix}`;
    const ticketId = `ticket_it_${suffix}`;
    const db = cleanup!;

    customerIds.push(customerId);
    await db.query(
      `INSERT INTO customers(id, email, name, tenure_days, tier, risk_score)
       VALUES ($1, $2, $3, 12, 'starter', 10)`,
      [customerId, `${suffix}@integration.example`, 'Integration Customer']
    );
    invoiceIds.push(invoiceId);
    await db.query(
      `INSERT INTO invoices(id, customer_id, amount_cents, refunded_amount_cents, currency, status, issued_at)
       VALUES ($1, $2, 2900, 0, 'USD', 'paid', NOW() - INTERVAL '2 days')`,
      [invoiceId, customerId]
    );
    ticketIds.push(ticketId);
    await db.query(
      `INSERT INTO tickets(id, customer_id, subject, raw_message, status, created_at)
       VALUES ($1, $2, 'Duplicate charge', 'I was charged twice.', 'open', NOW())`,
      [ticketId, customerId]
    );

    return { customerId, invoiceId, ticketId };
  }

  async function reconnect() {
    await repository.close();
    repository = new PostgresSupportRepository(databaseUrl!);
  }

  async function auditCount(entityId: string, actionType: string): Promise<number> {
    const result = await cleanup!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM audit_logs WHERE entity_id = $1 AND action_type = $2',
      [entityId, actionType]
    );
    return result.rows[0]!.count;
  }

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

  it('runs proposal, approval, and execution once under parallel retries', async () => {
    const supportCase = await createRefundCase();
    const proposalKey = idempotencyKey('proposal');
    const decisionKey = idempotencyKey('decision');
    const executionKey = idempotencyKey('execution');
    idempotencyKeys.push(proposalKey, decisionKey, executionKey);

    const proposals = await Promise.all(
      Array.from({ length: 8 }, () => repository.createRefundProposal(
        refundProposalInput(supportCase, proposalKey)
      ))
    );
    const proposal = proposals[0]!.proposal;
    expect(proposals.map(({ proposal: item }) => item.id)).toEqual(Array(8).fill(proposal.id));
    expect(proposals.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(proposal).toMatchObject({ status: 'PROPOSED', requiresHumanApproval: true });
    expect(await auditCount(proposal.id, 'REFUND_PROPOSED')).toBe(1);

    await reconnect();
    const decisionInput = {
      proposalId: proposal.id,
      decision: 'APPROVE' as const,
      operatorId: 'integration-supervisor',
      idempotencyKey: decisionKey,
    };
    const decisions = await Promise.all(
      Array.from({ length: 8 }, () => repository.decideRefundProposal(decisionInput))
    );
    expect(decisions.map(({ proposal: item }) => item.status)).toEqual(Array(8).fill('APPROVED'));
    expect(decisions.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(await repository.getTicket(supportCase.ticketId)).toMatchObject({ status: 'open' });
    expect(await repository.listCustomerInvoices(supportCase.customerId)).toMatchObject([
      { id: supportCase.invoiceId, refundedAmountCents: 0, status: 'paid' },
    ]);
    expect(await auditCount(proposal.id, 'REFUND_APPROVE')).toBe(1);

    await reconnect();
    const executions = await Promise.all(
      Array.from({ length: 8 }, () => repository.executeRefundProposal({
        proposalId: proposal.id,
        idempotencyKey: executionKey,
      }))
    );
    expect(executions.map(({ proposal: item }) => item.status)).toEqual(Array(8).fill('EXECUTED'));
    expect(executions.map(({ invoice }) => invoice.refundedAmountCents)).toEqual(Array(8).fill(2900));
    expect(executions.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(await repository.getTicket(supportCase.ticketId)).toMatchObject({ status: 'resolved' });
    expect(await repository.listCustomerInvoices(supportCase.customerId)).toMatchObject([
      { id: supportCase.invoiceId, refundedAmountCents: 2900, status: 'refunded' },
    ]);
    expect(await auditCount(proposal.id, 'REFUND_EXECUTED')).toBe(1);
    expect(await auditCount(proposal.id, 'REFUND_APPROVE')).toBe(1);
    expect(await auditCount(proposal.id, 'REFUND_PROPOSED')).toBe(1);
  });

  it('blocks execution until a supervisor approves the proposal', async () => {
    const supportCase = await createRefundCase();
    const proposalKey = idempotencyKey('proposal');
    const executionKey = idempotencyKey('execution');
    idempotencyKeys.push(proposalKey, executionKey);
    const { proposal } = await repository.createRefundProposal(refundProposalInput(supportCase, proposalKey));

    await expect(repository.executeRefundProposal({
      proposalId: proposal.id,
      idempotencyKey: executionKey,
    })).rejects.toBeInstanceOf(ApprovalRequiredError);

    expect(await repository.getTicket(supportCase.ticketId)).toMatchObject({ status: 'pending_approval' });
    expect(await repository.listCustomerInvoices(supportCase.customerId)).toMatchObject([
      { id: supportCase.invoiceId, refundedAmountCents: 0, status: 'paid' },
    ]);
    const stored = await cleanup!.query<{ status: string }>(
      'SELECT status FROM action_proposals WHERE id = $1',
      [proposal.id]
    );
    expect(stored.rows[0]?.status).toBe('PROPOSED');
    expect(await auditCount(proposal.id, 'REFUND_EXECUTED')).toBe(0);
  });

  it('commits the rejection audit without creating a proposal', async () => {
    const supportCase = await createRefundCase();
    const key = idempotencyKey('proposal-rejected');
    idempotencyKeys.push(key);

    await expect(repository.createRefundProposal(refundProposalInput(supportCase, key, 3000)))
      .rejects.toBeInstanceOf(PolicyMismatchError);

    expect(await auditCount(supportCase.ticketId, 'REFUND_ASSESSMENT_REJECTED')).toBe(1);
    const stored = await cleanup!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM action_proposals WHERE ticket_id = $1',
      [supportCase.ticketId]
    );
    expect(stored.rows[0]?.count).toBe(0);
    expect(await repository.getTicket(supportCase.ticketId)).toMatchObject({ status: 'open' });
  });

  it('rejects an idempotency key reused for a different proposal', async () => {
    const firstCase = await createRefundCase();
    const secondCase = await createRefundCase();
    const key = idempotencyKey('proposal');
    idempotencyKeys.push(key);

    await repository.createRefundProposal(refundProposalInput(firstCase, key));
    await expect(repository.createRefundProposal(refundProposalInput(secondCase, key, 2800)))
      .rejects.toBeInstanceOf(IdempotencyConflictError);

    const stored = await cleanup!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM action_proposals WHERE ticket_id = $1',
      [secondCase.ticketId]
    );
    expect(stored.rows[0]?.count).toBe(0);
    expect(await repository.getTicket(secondCase.ticketId)).toMatchObject({ status: 'open' });
  });
});
