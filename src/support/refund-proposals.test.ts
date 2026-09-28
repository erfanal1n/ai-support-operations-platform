import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError, PolicyMismatchError, StateConflictError } from '../core/errors.js';
import { MemoryStore } from '../data/db.js';
import { createRefundProposal } from './refund-proposals.js';

const now = new Date();

const proposalInput = {
  ticketId: 'ticket_solo_duplicate_charge',
  invoiceId: 'inv_solo_001',
  policyId: 'POL-REFUND-STANDARD',
  amountCents: 2900,
  idempotencyKey: 'refund-proposal-solo-001',
};

describe('createRefundProposal', () => {
  it('creates a proposal with policy evidence and a human approval gate', () => {
    const store = new MemoryStore();

    const { proposal, replayed } = createRefundProposal(store, proposalInput, now);

    expect(replayed).toBe(false);
    expect(proposal).toMatchObject({
      ticketId: proposalInput.ticketId,
      customerId: 'cust_solo_dev',
      actionType: 'ISSUE_REFUND',
      targetInvoiceId: proposalInput.invoiceId,
      amountCents: 2900,
      matchedPolicyId: proposalInput.policyId,
      requiresHumanApproval: true,
      approvalReason: 'CUSTOMER_TENURE_BELOW_MINIMUM',
      status: 'PROPOSED',
    });
    expect(proposal.policyCitation).toContain('within 14 days');
    expect(store.tickets.get(proposalInput.ticketId)?.status).toBe('pending_approval');
    expect(store.auditLogs.at(-1)?.actionType).toBe('REFUND_PROPOSED');
  });

  it('replays the same proposal for a repeated idempotency key', () => {
    const store = new MemoryStore();
    const first = createRefundProposal(store, proposalInput, now);
    const second = createRefundProposal(store, proposalInput, now);

    expect(second).toEqual({ proposal: first.proposal, replayed: true });
    expect(store.proposals.size).toBe(1);
    expect(store.auditLogs.filter(({ actionType }) => actionType === 'REFUND_PROPOSED')).toHaveLength(1);
  });

  it('rejects an idempotency key reused with different input', () => {
    const store = new MemoryStore();
    createRefundProposal(store, proposalInput, now);

    expect(() =>
      createRefundProposal(store, { ...proposalInput, amountCents: 2800 }, now)
    ).toThrow(IdempotencyConflictError);
    expect(store.proposals.size).toBe(1);
  });

  it('does not create a second unresolved proposal for the same invoice', () => {
    const store = new MemoryStore();
    createRefundProposal(store, proposalInput, now);

    expect(() =>
      createRefundProposal(store, { ...proposalInput, idempotencyKey: 'refund-proposal-solo-002' }, now)
    ).toThrow(StateConflictError);
    expect(store.proposals.size).toBe(1);
  });

  it('audits and rejects a refund that exceeds the invoice balance', () => {
    const store = new MemoryStore();

    expect(() =>
      createRefundProposal(store, { ...proposalInput, amountCents: 3000 }, now)
    ).toThrow(PolicyMismatchError);
    expect(store.proposals.size).toBe(0);
    expect(store.auditLogs.at(-1)?.actionType).toBe('REFUND_ASSESSMENT_REJECTED');
  });
});
