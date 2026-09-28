import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type {
  ActionProposal,
  AuditEntry,
  CustomerProfile,
  InvoiceRecord,
  PolicyRule,
  SupportTicket,
  TicketStatus,
} from '../core/types.js';
import { ApprovalRequiredError, IdempotencyConflictError, NotFoundError, PolicyMismatchError, StateConflictError } from '../core/errors.js';
import { assessRefund } from '../core/refund-assessment.js';
import type { CreateRefundProposalInput, CreateRefundProposalResult } from '../support/refund-proposals.js';
import type { DecideRefundProposalInput, RefundDecisionResult } from '../support/refund-decisions.js';
import type { ExecuteRefundInput, ExecuteRefundResult } from '../support/refund-execution.js';
import type { PolicySearchHit } from '../support/policy-search.js';
import type { CreateTicketInput, TicketContext, TicketListEntry } from '../support/tickets.js';
import type { LoginAttemptResult, OperatorSessionRecord, SupportRepository } from './repository.js';

interface CustomerRow extends QueryResultRow {
  id: string;
  email: string;
  name: string;
  tenure_days: number;
  tier: CustomerProfile['tier'];
  risk_score: number;
}

interface InvoiceRow extends QueryResultRow {
  id: string;
  customer_id: string;
  amount_cents: string;
  refunded_amount_cents: string;
  currency: string;
  status: InvoiceRecord['status'];
  issued_at: Date;
}

interface PolicyRow extends QueryResultRow {
  id: string;
  category: PolicyRule['category'];
  title: string;
  summary: string;
  full_text: string;
  max_auto_approved_cents: string;
  min_tenure_days: number;
  refund_window_days: number | null;
  keywords: string[];
}

interface TicketRow extends QueryResultRow {
  id: string;
  customer_id: string;
  subject: string;
  raw_message: string;
  status: TicketStatus;
  created_at: Date;
  resolved_at: Date | null;
}

interface ProposalRow extends QueryResultRow {
  id: string;
  ticket_id: string;
  customer_id: string;
  action_type: ActionProposal['actionType'];
  target_invoice_id: string | null;
  amount_cents: string | null;
  matched_policy_id: string;
  policy_citation: string;
  requires_human_approval: boolean;
  approval_reason: string | null;
  status: ActionProposal['status'];
  created_at: Date;
  executed_at: Date | null;
}

interface IdempotencyRow extends QueryResultRow {
  fingerprint: string;
  response: unknown;
}

class CommitThenThrow {
  constructor(readonly error: Error) {}
}

function integer(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError('Database integer exceeds JavaScript safe range');
  return parsed;
}

function iso(value: Date | null): string | undefined {
  return value?.toISOString();
}

function customer(row: CustomerRow): CustomerProfile {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tenureDays: row.tenure_days,
    tier: row.tier,
    riskScore: row.risk_score,
  };
}

function invoice(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    amountCents: integer(row.amount_cents),
    refundedAmountCents: integer(row.refunded_amount_cents),
    currency: row.currency.trim(),
    status: row.status,
    issuedAt: row.issued_at.toISOString(),
  };
}

function policy(row: PolicyRow): PolicyRule {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    summary: row.summary,
    fullText: row.full_text,
    maxAutoApprovedCents: integer(row.max_auto_approved_cents),
    minTenureDays: row.min_tenure_days,
    refundWindowDays: row.refund_window_days ?? undefined,
    keywords: row.keywords,
  };
}

function ticket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    customerId: row.customer_id,
    subject: row.subject,
    rawMessage: row.raw_message,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    resolvedAt: iso(row.resolved_at),
  };
}

function proposal(row: ProposalRow): ActionProposal {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    customerId: row.customer_id,
    actionType: row.action_type,
    targetInvoiceId: row.target_invoice_id ?? undefined,
    amountCents: row.amount_cents === null ? undefined : integer(row.amount_cents),
    matchedPolicyId: row.matched_policy_id,
    policyCitation: row.policy_citation,
    requiresHumanApproval: row.requires_human_approval,
    approvalReason: row.approval_reason ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    executedAt: iso(row.executed_at),
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class PostgresSupportRepository implements SupportRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', (error) => process.stderr.write(`PostgreSQL pool error: ${error.message}\n`));
  }

  async health(): Promise<void> {
    const result = await this.pool.query<{
      tickets: string | null;
      proposals: string | null;
      sessions: string | null;
      loginAttempts: string | null;
      schema: string | null;
    }>(
      `SELECT to_regclass('public.tickets') AS tickets,
              to_regclass('public.action_proposals') AS proposals,
              to_regclass('public.operator_sessions') AS sessions,
              to_regclass('public.auth_login_attempts') AS "loginAttempts",
              to_regclass('public.schema_migrations') AS schema`
    );
    const schema = result.rows[0];
    if (!schema?.tickets || !schema.proposals || !schema.sessions || !schema.loginAttempts || !schema.schema) {
      throw new Error('Database schema is missing; run pnpm db:migrate');
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createOperatorSession(session: OperatorSessionRecord): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('DELETE FROM operator_sessions WHERE expires_at <= NOW()');
      await client.query(
        `INSERT INTO operator_sessions(session_hash, operator_id, credential_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [session.sessionHash, session.operatorId, session.credentialHash, session.expiresAt]
      );
    });
  }

  async getOperatorSession(sessionHash: string): Promise<OperatorSessionRecord | null> {
    const result = await this.pool.query<{
      operator_id: string;
      credential_hash: string;
      expires_at: Date;
    }>(
      'SELECT operator_id, credential_hash, expires_at FROM operator_sessions WHERE session_hash = $1 AND expires_at > NOW()',
      [sessionHash]
    );
    const row = result.rows[0];
    return row ? {
      sessionHash,
      operatorId: row.operator_id,
      credentialHash: row.credential_hash,
      expiresAt: row.expires_at.toISOString(),
    } : null;
  }

  async deleteOperatorSession(sessionHash: string): Promise<void> {
    await this.pool.query('DELETE FROM operator_sessions WHERE session_hash = $1', [sessionHash]);
  }

  async consumeLoginAttempt(key: string, windowSeconds: number, maxAttempts: number): Promise<LoginAttemptResult> {
    await this.pool.query(
      `DELETE FROM auth_login_attempts
       WHERE window_started_at <= NOW() - ($1::int * INTERVAL '1 second')`,
      [windowSeconds]
    );

    const result = await this.pool.query<{
      attempts: number;
      retry_after_seconds: number;
    }>(
      `INSERT INTO auth_login_attempts(attempt_key, window_started_at, attempts)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (attempt_key) DO UPDATE
       SET window_started_at = CASE
             WHEN auth_login_attempts.window_started_at + ($2::int * INTERVAL '1 second') <= NOW() THEN NOW()
             ELSE auth_login_attempts.window_started_at
           END,
           attempts = CASE
             WHEN auth_login_attempts.window_started_at + ($2::int * INTERVAL '1 second') <= NOW() THEN 1
             ELSE auth_login_attempts.attempts + 1
           END
       RETURNING attempts,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
           window_started_at + ($2::int * INTERVAL '1 second') - NOW()
         )))::int) AS retry_after_seconds`,
      [key, windowSeconds]
    );
    const row = result.rows[0]!;
    return { allowed: row.attempts <= maxAttempts, retryAfterSeconds: row.retry_after_seconds };
  }

  async clearLoginAttempts(key: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_login_attempts WHERE attempt_key = $1', [key]);
  }

  async getTicket(id: string): Promise<SupportTicket | null> {
    const result = await this.pool.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [id]);
    return result.rows[0] ? ticket(result.rows[0]) : null;
  }

  async getCustomer(id: string): Promise<CustomerProfile | null> {
    const result = await this.pool.query<CustomerRow>('SELECT * FROM customers WHERE id = $1', [id]);
    return result.rows[0] ? customer(result.rows[0]) : null;
  }

  async listCustomerInvoices(customerId: string): Promise<InvoiceRecord[]> {
    const result = await this.pool.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE customer_id = $1 ORDER BY issued_at DESC, id',
      [customerId]
    );
    return result.rows.map(invoice);
  }

  async listPolicies(): Promise<PolicyRule[]> {
    const result = await this.pool.query<PolicyRow>('SELECT * FROM policies ORDER BY id');
    return result.rows.map(policy);
  }

  async listTickets(status?: TicketStatus): Promise<TicketListEntry[]> {
    const result = await this.pool.query<{
      id: string;
      subject: string;
      status: TicketStatus;
      created_at: Date;
      customer_id: string;
      customer_name: string;
      tier: CustomerProfile['tier'];
    }>(
      `SELECT t.id, t.subject, t.status, t.created_at, c.id AS customer_id, c.name AS customer_name, c.tier
       FROM tickets t JOIN customers c ON c.id = t.customer_id
       WHERE $1::text IS NULL OR t.status = $1
       ORDER BY t.created_at DESC, t.id`,
      [status ?? null]
    );

    return result.rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      customer: { id: row.customer_id, name: row.customer_name, tier: row.tier },
    }));
  }

  async getTicketContext(ticketId: string, policyHits: PolicySearchHit[]): Promise<TicketContext> {
    const foundTicket = await this.getTicket(ticketId);
    if (!foundTicket) throw new NotFoundError('Ticket', ticketId);

    const foundCustomer = await this.getCustomer(foundTicket.customerId);
    if (!foundCustomer) throw new NotFoundError('Customer', foundTicket.customerId);

    const [invoices, proposalRows] = await Promise.all([
      this.listCustomerInvoices(foundCustomer.id),
      this.pool.query<ProposalRow>('SELECT * FROM action_proposals WHERE ticket_id = $1 ORDER BY created_at, id', [ticketId]),
    ]);

    return {
      ticket: foundTicket,
      customer: {
        id: foundCustomer.id,
        name: foundCustomer.name,
        tier: foundCustomer.tier,
        tenureDays: foundCustomer.tenureDays,
      },
      invoices: invoices.map(({ id, amountCents, refundedAmountCents, currency, status, issuedAt }) => ({
        id,
        amountCents,
        refundedAmountCents,
        currency,
        status,
        issuedAt,
      })),
      relevantPolicies: policyHits.map(({ policy: matched, matchedKeywords }) => ({
        id: matched.id,
        category: matched.category,
        title: matched.title,
        summary: matched.summary,
        fullText: matched.fullText,
        matchedKeywords,
      })),
      proposals: proposalRows.rows.map((row) => {
        const item = proposal(row);
        return {
          id: item.id,
          actionType: item.actionType,
          status: item.status,
          amountCents: item.amountCents,
          targetInvoiceId: item.targetInvoiceId,
          matchedPolicyId: item.matchedPolicyId,
          requiresHumanApproval: item.requiresHumanApproval,
          approvalReason: item.approvalReason,
          createdAt: item.createdAt,
          executedAt: item.executedAt,
        };
      }),
    };
  }

  async createTicket(input: CreateTicketInput): Promise<SupportTicket> {
    return this.transaction(async (client) => {
      const account = await client.query('SELECT 1 FROM customers WHERE id = $1', [input.customerId]);
      if (!account.rowCount) throw new NotFoundError('Customer', input.customerId);

      const created: SupportTicket = {
        id: `ticket_${randomUUID()}`,
        customerId: input.customerId,
        subject: input.subject,
        rawMessage: input.rawMessage,
        status: 'open',
        createdAt: new Date().toISOString(),
      };

      await this.writeTicket(client, created);
      await this.appendAudit(client, 'SYSTEM', 'TICKET_CREATED', created.id, { customerId: created.customerId });
      return created;
    });
  }

  async createRefundProposal(input: CreateRefundProposalInput): Promise<CreateRefundProposalResult> {
    const requestFingerprint = fingerprint([input.ticketId, input.invoiceId, input.policyId, input.amountCents]);

    return this.transaction(async (client) => {
      const previous = await this.previousRequest(client, 'refund-proposal', input.idempotencyKey, requestFingerprint);
      if (previous) return { proposal: (previous.response as { proposal: ActionProposal }).proposal, replayed: true };

      const ticketRow = await this.selectTicket(client, input.ticketId, true);
      if (!ticketRow) throw new NotFoundError('Ticket', input.ticketId);
      const currentTicket = ticket(ticketRow);
      if (currentTicket.status !== 'open') throw new StateConflictError('Ticket is not open for a refund proposal');

      const customerRow = await this.selectCustomer(client, currentTicket.customerId);
      if (!customerRow) throw new NotFoundError('Customer', currentTicket.customerId);

      const invoiceRow = await this.selectInvoice(client, input.invoiceId, true);
      if (!invoiceRow) throw new NotFoundError('Invoice', input.invoiceId);

      const policyRow = await this.selectPolicy(client, input.policyId);
      if (!policyRow) throw new NotFoundError('Policy', input.policyId);

      const existing = await client.query(
        `SELECT 1 FROM action_proposals
         WHERE ticket_id = $1 AND target_invoice_id = $2 AND action_type = 'ISSUE_REFUND'
           AND status IN ('PROPOSED', 'APPROVED') LIMIT 1`,
        [currentTicket.id, invoiceRow.id]
      );
      if (existing.rowCount) throw new StateConflictError('An unresolved refund proposal already exists for this invoice');

      const currentInvoice = invoice(invoiceRow);
      const currentPolicy = policy(policyRow);
      const now = new Date();
      const assessment = assessRefund({
        customer: customer(customerRow),
        invoice: currentInvoice,
        policy: currentPolicy,
        amountCents: input.amountCents,
        now,
      });

      if (assessment.disposition === 'REJECTED') {
        await this.appendAudit(client, 'SYSTEM', 'REFUND_ASSESSMENT_REJECTED', currentTicket.id, {
          invoiceId: currentInvoice.id,
          policyId: currentPolicy.id,
          amountCents: input.amountCents,
          reason: assessment.reason,
        });
        this.commitThenThrow(new PolicyMismatchError(assessment.reason));
      }

      const requiresHumanApproval = assessment.disposition === 'REQUIRES_APPROVAL';
      const created: ActionProposal = {
        id: `proposal_${randomUUID()}`,
        ticketId: currentTicket.id,
        customerId: customerRow.id,
        actionType: 'ISSUE_REFUND',
        targetInvoiceId: currentInvoice.id,
        amountCents: input.amountCents,
        matchedPolicyId: currentPolicy.id,
        policyCitation: currentPolicy.fullText,
        requiresHumanApproval,
        approvalReason: requiresHumanApproval ? assessment.reasons.join(', ') : undefined,
        status: 'PROPOSED',
        createdAt: now.toISOString(),
      };
      const result = { proposal: created, replayed: false };

      await this.writeProposal(client, created);
      if (requiresHumanApproval) await this.writeTicket(client, { ...currentTicket, status: 'pending_approval' });
      await this.writeIdempotency(client, 'refund-proposal', input.idempotencyKey, requestFingerprint, { proposal: created });
      await this.appendAudit(client, 'SYSTEM', 'REFUND_PROPOSED', created.id, {
        ticketId: currentTicket.id,
        invoiceId: currentInvoice.id,
        policyId: currentPolicy.id,
        amountCents: input.amountCents,
        requiresHumanApproval,
      });

      return result;
    });
  }

  async decideRefundProposal(input: DecideRefundProposalInput): Promise<RefundDecisionResult> {
    const requestFingerprint = fingerprint([input.proposalId, input.decision, input.operatorId]);

    return this.transaction(async (client) => {
      const previous = await this.previousRequest(client, 'refund-decision', input.idempotencyKey, requestFingerprint);
      if (previous) return { proposal: (previous.response as { proposal: ActionProposal }).proposal, replayed: true };

      const proposalRow = await this.selectProposal(client, input.proposalId, true);
      if (!proposalRow) throw new NotFoundError('Refund proposal', input.proposalId);
      const currentProposal = proposal(proposalRow);
      if (currentProposal.status !== 'PROPOSED') throw new StateConflictError('Refund proposal already has a decision');

      const ticketRow = await this.selectTicket(client, currentProposal.ticketId, true);
      if (!ticketRow) throw new NotFoundError('Ticket', currentProposal.ticketId);
      const currentTicket = ticket(ticketRow);
      if (currentProposal.requiresHumanApproval && currentTicket.status !== 'pending_approval') {
        throw new StateConflictError('Ticket is not waiting for approval');
      }

      const status: ActionProposal['status'] = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const updatedProposal = { ...currentProposal, status };
      const updatedTicket: SupportTicket = {
        ...currentTicket,
        status: input.decision === 'APPROVE' ? 'open' : 'rejected',
      };
      const result = { proposal: updatedProposal, replayed: false };

      await this.writeProposal(client, updatedProposal);
      await this.writeTicket(client, updatedTicket);
      await this.appendAudit(client, 'OPERATOR', `REFUND_${input.decision}`, currentProposal.id, {
        ticketId: currentTicket.id,
        operatorId: input.operatorId,
      }, input.operatorId);
      await this.writeIdempotency(client, 'refund-decision', input.idempotencyKey, requestFingerprint, { proposal: updatedProposal });

      return result;
    });
  }

  async executeRefundProposal(input: ExecuteRefundInput): Promise<ExecuteRefundResult> {
    const requestFingerprint = fingerprint(input.proposalId);

    return this.transaction(async (client) => {
      const previous = await this.previousRequest(client, 'refund-execution', input.idempotencyKey, requestFingerprint);
      if (previous) {
        const result = previous.response as { proposal: ActionProposal; invoice: InvoiceRecord };
        return { ...result, replayed: true };
      }

      const proposalRow = await this.selectProposal(client, input.proposalId, true);
      if (!proposalRow) throw new NotFoundError('Refund proposal', input.proposalId);
      const currentProposal = proposal(proposalRow);
      if (currentProposal.actionType !== 'ISSUE_REFUND' || !currentProposal.targetInvoiceId || currentProposal.amountCents === undefined) {
        throw new StateConflictError('Proposal is not a complete refund action');
      }
      if (currentProposal.status !== 'PROPOSED' && currentProposal.status !== 'APPROVED') {
        throw new StateConflictError('Refund proposal cannot be executed in its current state');
      }

      const ticketRow = await this.selectTicket(client, currentProposal.ticketId, true);
      if (!ticketRow) throw new NotFoundError('Ticket', currentProposal.ticketId);
      const customerRow = await this.selectCustomer(client, currentProposal.customerId);
      if (!customerRow) throw new NotFoundError('Customer', currentProposal.customerId);
      const invoiceRow = await this.selectInvoice(client, currentProposal.targetInvoiceId, true);
      if (!invoiceRow) throw new NotFoundError('Invoice', currentProposal.targetInvoiceId);
      const policyRow = await this.selectPolicy(client, currentProposal.matchedPolicyId);
      if (!policyRow) throw new NotFoundError('Policy', currentProposal.matchedPolicyId);

      const currentTicket = ticket(ticketRow);
      const currentInvoice = invoice(invoiceRow);
      const assessment = assessRefund({
        customer: customer(customerRow),
        invoice: currentInvoice,
        policy: policy(policyRow),
        amountCents: currentProposal.amountCents,
      });

      if (assessment.disposition === 'REJECTED') {
        await this.appendAudit(client, 'SYSTEM', 'REFUND_EXECUTION_REJECTED', currentProposal.id, {
          invoiceId: currentInvoice.id,
          reason: assessment.reason,
        });
        this.commitThenThrow(new PolicyMismatchError(assessment.reason));
      }

      if (assessment.disposition === 'REQUIRES_APPROVAL' && currentProposal.status === 'PROPOSED') {
        const updatedProposal = currentProposal.requiresHumanApproval
          ? currentProposal
          : {
              ...currentProposal,
              requiresHumanApproval: true,
              approvalReason: assessment.reasons.join(', '),
            };

        if (!currentProposal.requiresHumanApproval) {
          await this.writeProposal(client, updatedProposal);
          await this.writeTicket(client, { ...currentTicket, status: 'pending_approval' });
          await this.appendAudit(client, 'SYSTEM', 'REFUND_REQUIRES_APPROVAL', currentProposal.id, {
            ticketId: currentTicket.id,
            reasons: assessment.reasons,
          });
        }
        this.commitThenThrow(new ApprovalRequiredError(currentProposal.id, assessment.reasons.join(', ')));
      }

      if (currentProposal.requiresHumanApproval && currentProposal.status !== 'APPROVED') {
        throw new ApprovalRequiredError(currentProposal.id, currentProposal.approvalReason ?? 'operator approval is missing');
      }

      const refundedAmountCents = currentInvoice.refundedAmountCents + currentProposal.amountCents;
      const updatedInvoice: InvoiceRecord = {
        ...currentInvoice,
        refundedAmountCents,
        status: refundedAmountCents === currentInvoice.amountCents ? 'refunded' : 'partially_refunded',
      };
      const executedAt = new Date().toISOString();
      const updatedProposal: ActionProposal = { ...currentProposal, status: 'EXECUTED', executedAt };
      const unresolved = await client.query<ProposalRow>(
        `SELECT * FROM action_proposals
         WHERE ticket_id = $1 AND id <> $2 AND status IN ('PROPOSED', 'APPROVED')`,
        [currentTicket.id, currentProposal.id]
      );
      const unresolvedProposals = unresolved.rows.map(proposal);
      const hasPendingApproval = unresolvedProposals.some(
        (candidate) => candidate.requiresHumanApproval && candidate.status === 'PROPOSED'
      );
      const ticketStatus = hasPendingApproval
        ? 'pending_approval'
        : unresolvedProposals.length > 0
          ? 'open'
          : 'resolved';
      const updatedTicket: SupportTicket = {
        ...currentTicket,
        status: ticketStatus,
        resolvedAt: ticketStatus === 'resolved' ? executedAt : undefined,
      };
      const result = { proposal: updatedProposal, invoice: updatedInvoice, replayed: false };

      await this.writeInvoice(client, updatedInvoice);
      await this.writeProposal(client, updatedProposal);
      await this.writeTicket(client, updatedTicket);
      await this.appendAudit(client, 'SYSTEM', 'REFUND_EXECUTED', currentProposal.id, {
        ticketId: currentTicket.id,
        invoiceId: currentInvoice.id,
        amountCents: currentProposal.amountCents,
        refundedAmountCents,
      });
      await this.writeIdempotency(client, 'refund-execution', input.idempotencyKey, requestFingerprint, {
        proposal: updatedProposal,
        invoice: updatedInvoice,
      });

      return result;
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;

    try {
      await client.query('BEGIN');
      try {
        const result = await operation(client);
        await client.query('COMMIT');
        committed = true;
        return result;
      } catch (error) {
        if (error instanceof CommitThenThrow) {
          await client.query('COMMIT');
          committed = true;
          throw error.error;
        }
        throw error;
      }
    } catch (error) {
      if (!committed) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private commitThenThrow(error: Error): never {
    throw new CommitThenThrow(error);
  }

  private async previousRequest(
    client: PoolClient,
    operation: 'refund-proposal' | 'refund-decision' | 'refund-execution',
    key: string,
    requestFingerprint: string
  ): Promise<IdempotencyRow | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${operation}:${key}`]);
    const result = await client.query<IdempotencyRow>(
      'SELECT fingerprint, response FROM idempotency_records WHERE operation = $1 AND key = $2',
      [operation, key]
    );
    const previous = result.rows[0];
    if (!previous) return null;
    if (previous.fingerprint !== requestFingerprint) throw new IdempotencyConflictError();
    return previous;
  }

  private async writeIdempotency(
    client: PoolClient,
    operation: 'refund-proposal' | 'refund-decision' | 'refund-execution',
    key: string,
    requestFingerprint: string,
    response: unknown
  ): Promise<void> {
    await client.query(
      'INSERT INTO idempotency_records(operation, key, fingerprint, response) VALUES ($1, $2, $3, $4::jsonb)',
      [operation, key, requestFingerprint, JSON.stringify(response)]
    );
  }

  private async selectTicket(client: PoolClient, id: string, lock = false): Promise<TicketRow | null> {
    const result = await client.query<TicketRow>(`SELECT * FROM tickets WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] ?? null;
  }

  private async selectCustomer(client: PoolClient, id: string): Promise<CustomerRow | null> {
    const result = await client.query<CustomerRow>('SELECT * FROM customers WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  private async selectInvoice(client: PoolClient, id: string, lock = false): Promise<InvoiceRow | null> {
    const result = await client.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] ?? null;
  }

  private async selectPolicy(client: PoolClient, id: string): Promise<PolicyRow | null> {
    const result = await client.query<PolicyRow>('SELECT * FROM policies WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  private async selectProposal(client: PoolClient, id: string, lock = false): Promise<ProposalRow | null> {
    const result = await client.query<ProposalRow>(`SELECT * FROM action_proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] ?? null;
  }

  private async writeTicket(client: PoolClient, value: SupportTicket): Promise<void> {
    await client.query(
      `INSERT INTO tickets(id, customer_id, subject, raw_message, status, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at`,
      [value.id, value.customerId, value.subject, value.rawMessage, value.status, value.createdAt, value.resolvedAt ?? null]
    );
  }

  private async writeInvoice(client: PoolClient, value: InvoiceRecord): Promise<void> {
    await client.query(
      `UPDATE invoices SET refunded_amount_cents = $2, status = $3 WHERE id = $1`,
      [value.id, value.refundedAmountCents, value.status]
    );
  }

  private async writeProposal(client: PoolClient, value: ActionProposal): Promise<void> {
    await client.query(
      `INSERT INTO action_proposals(
         id, ticket_id, customer_id, action_type, target_invoice_id, amount_cents, matched_policy_id,
         policy_citation, requires_human_approval, approval_reason, status, created_at, executed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         requires_human_approval = EXCLUDED.requires_human_approval,
         approval_reason = EXCLUDED.approval_reason,
         status = EXCLUDED.status,
         executed_at = EXCLUDED.executed_at`,
      [
        value.id,
        value.ticketId,
        value.customerId,
        value.actionType,
        value.targetInvoiceId ?? null,
        value.amountCents ?? null,
        value.matchedPolicyId,
        value.policyCitation,
        value.requiresHumanApproval,
        value.approvalReason ?? null,
        value.status,
        value.createdAt,
        value.executedAt ?? null,
      ]
    );
  }

  private async appendAudit(
    client: PoolClient,
    actor: AuditEntry['actor'],
    actionType: string,
    entityId: string,
    details: Record<string, unknown>,
    operatorId?: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs(id, timestamp, actor, operator_id, action_type, entity_id, details)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), actor, operatorId ?? null, actionType, entityId, JSON.stringify(details)]
    );
  }
}
