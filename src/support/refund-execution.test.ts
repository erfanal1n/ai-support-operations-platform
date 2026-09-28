import { describe, expect, it } from 'vitest';
import { ApprovalRequiredError, PolicyMismatchError, StateConflictError } from '../core/errors.js';
import { MemoryStore } from '../data/db.js';
import { createRefundProposal } from './refund-proposals.js';
import { decideRefundProposal } from './refund-decisions.js';
import { executeRefundProposal } from './refund-execution.js';

const now = new Date();

function prepareProposal(
  store: MemoryStore,
  ticketId = 'ticket_solo_duplicate_charge',
  invoiceId = 'inv_solo_001',
  amountCents = 2900
) {
  return createRefundProposal(store, {
    ticketId,
    invoiceId,
    policyId: 'POL-REFUND-STANDARD',
    amountCents,
    idempotencyKey: `proposal-${ticketId}-${invoiceId}`,
  }).proposal;
}

describe('executeRefundProposal', () => {
  it('blocks a manual proposal until an operator approves it', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);

    expect(() =>
      executeRefundProposal(store, {
        proposalId: proposal.id,
        idempotencyKey: 'refund-execution-solo-001',
      }, now)
    ).toThrow(ApprovalRequiredError);
    expect(store.invoices.get('inv_solo_001')?.refundedAmountCents).toBe(0);
  });

  it('executes an approved refund, updates the invoice, and replays safely', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);
    decideRefundProposal(store, {
      proposalId: proposal.id,
      decision: 'APPROVE',
      operatorId: 'operator-17',
      idempotencyKey: 'refund-approval-solo-001',
    });
    const input = { proposalId: proposal.id, idempotencyKey: 'refund-execution-solo-001' };

    const first = executeRefundProposal(store, input, now);
    const replay = executeRefundProposal(store, input, now);

    expect(first.proposal.status).toBe('EXECUTED');
    expect(first.invoice).toMatchObject({ refundedAmountCents: 2900, status: 'refunded' });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(store.tickets.get(proposal.ticketId)).toMatchObject({ status: 'resolved', resolvedAt: now.toISOString() });
    expect(store.auditLogs.filter(({ actionType }) => actionType === 'REFUND_EXECUTED')).toHaveLength(1);
  });

  it('executes policy-approved refunds without a human decision', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store, 'ticket_acme_refund_review', 'inv_acme_001', 4900);

    expect(proposal.requiresHumanApproval).toBe(false);
    const result = executeRefundProposal(store, {
      proposalId: proposal.id,
      idempotencyKey: 'refund-execution-acme-001',
    }, now);

    expect(result.proposal.status).toBe('EXECUTED');
    expect(result.invoice).toMatchObject({ refundedAmountCents: 4900, status: 'refunded' });
  });

  it('re-checks the refund window before execution', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);
    decideRefundProposal(store, {
      proposalId: proposal.id,
      decision: 'APPROVE',
      operatorId: 'operator-17',
      idempotencyKey: 'refund-approval-solo-001',
    });
    const invoice = store.invoices.get('inv_solo_001');
    if (!invoice) throw new Error('Invoice fixture is missing');
    store.invoices.set(invoice.id, { ...invoice, issuedAt: '2026-01-01T00:00:00.000Z' });

    expect(() =>
      executeRefundProposal(store, {
        proposalId: proposal.id,
        idempotencyKey: 'refund-execution-solo-001',
      }, now)
    ).toThrow(PolicyMismatchError);
    expect(store.invoices.get(invoice.id)?.refundedAmountCents).toBe(0);
    expect(store.auditLogs.at(-1)?.actionType).toBe('REFUND_EXECUTION_REJECTED');
  });

  it('does not execute an already completed proposal under a new key', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store, 'ticket_acme_refund_review', 'inv_acme_001', 4900);
    executeRefundProposal(store, {
      proposalId: proposal.id,
      idempotencyKey: 'refund-execution-acme-001',
    }, now);

    expect(() =>
      executeRefundProposal(store, {
        proposalId: proposal.id,
        idempotencyKey: 'refund-execution-acme-002',
      }, now)
    ).toThrow(StateConflictError);
  });
});
