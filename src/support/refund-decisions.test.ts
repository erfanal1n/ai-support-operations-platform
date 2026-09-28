import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError, StateConflictError } from '../core/errors.js';
import { MemoryStore } from '../data/db.js';
import { createRefundProposal } from './refund-proposals.js';
import { decideRefundProposal } from './refund-decisions.js';

const proposalInput = {
  ticketId: 'ticket_solo_duplicate_charge',
  invoiceId: 'inv_solo_001',
  policyId: 'POL-REFUND-STANDARD',
  amountCents: 2900,
  idempotencyKey: 'refund-proposal-solo-001',
};

function prepareProposal(store: MemoryStore) {
  return createRefundProposal(store, proposalInput).proposal;
}

describe('decideRefundProposal', () => {
  it('records operator approval and returns the ticket to the open queue', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);

    const result = decideRefundProposal(store, {
      proposalId: proposal.id,
      decision: 'APPROVE',
      operatorId: 'operator-17',
      idempotencyKey: 'refund-approval-solo-001',
    });

    expect(result.proposal.status).toBe('APPROVED');
    expect(store.tickets.get(proposal.ticketId)?.status).toBe('open');
    expect(store.invoices.get(proposal.targetInvoiceId!)?.refundedAmountCents).toBe(0);
    expect(store.auditLogs.at(-1)).toMatchObject({
      actor: 'OPERATOR',
      operatorId: 'operator-17',
      actionType: 'REFUND_APPROVE',
    });
  });

  it('records rejection and closes the ticket as rejected', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);

    const result = decideRefundProposal(store, {
      proposalId: proposal.id,
      decision: 'REJECT',
      operatorId: 'operator-17',
      idempotencyKey: 'refund-rejection-solo-001',
    });

    expect(result.proposal.status).toBe('REJECTED');
    expect(store.tickets.get(proposal.ticketId)?.status).toBe('rejected');
  });

  it('replays the same decision and rejects an idempotency key conflict', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);
    const input = {
      proposalId: proposal.id,
      decision: 'APPROVE' as const,
      operatorId: 'operator-17',
      idempotencyKey: 'refund-approval-solo-001',
    };
    const first = decideRefundProposal(store, input);
    store.proposals.set(proposal.id, { ...first.proposal, status: 'EXECUTED' });

    expect(decideRefundProposal(store, input)).toEqual({ proposal: first.proposal, replayed: true });
    expect(() =>
      decideRefundProposal(store, { ...input, decision: 'REJECT' })
    ).toThrow(IdempotencyConflictError);
  });

  it('does not allow a second decision with a new key', () => {
    const store = new MemoryStore();
    const proposal = prepareProposal(store);
    decideRefundProposal(store, {
      proposalId: proposal.id,
      decision: 'APPROVE',
      operatorId: 'operator-17',
      idempotencyKey: 'refund-approval-solo-001',
    });

    expect(() =>
      decideRefundProposal(store, {
        proposalId: proposal.id,
        decision: 'REJECT',
        operatorId: 'operator-17',
        idempotencyKey: 'refund-rejection-solo-002',
      })
    ).toThrow(StateConflictError);
  });
});
