import { createHash } from 'node:crypto';
import { IdempotencyConflictError, NotFoundError, StateConflictError } from '../core/errors.js';
import type { ActionProposal, SupportTicket } from '../core/types.js';
import type { MemoryStore } from '../data/db.js';

export type RefundDecision = 'APPROVE' | 'REJECT';

export interface DecideRefundProposalInput {
  proposalId: string;
  decision: RefundDecision;
  operatorId: string;
  idempotencyKey: string;
}

export interface RefundDecisionResult {
  proposal: ActionProposal;
  replayed: boolean;
}

function fingerprint(input: DecideRefundProposalInput): string {
  const requestShape = [input.proposalId, input.decision, input.operatorId];
  return createHash('sha256').update(JSON.stringify(requestShape)).digest('hex');
}

export function decideRefundProposal(
  store: MemoryStore,
  input: DecideRefundProposalInput
): RefundDecisionResult {
  const requestFingerprint = fingerprint(input);
  const previousDecision = store.refundDecisionKeys.get(input.idempotencyKey);

  if (previousDecision) {
    if (previousDecision.fingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError();
    }
    return { proposal: { ...previousDecision.proposal }, replayed: true };
  }

  const proposal = store.proposals.get(input.proposalId);
  if (!proposal) throw new NotFoundError('Refund proposal', input.proposalId);
  if (proposal.status !== 'PROPOSED') {
    throw new StateConflictError('Refund proposal already has a decision');
  }

  const ticket = store.tickets.get(proposal.ticketId);
  if (!ticket) throw new NotFoundError('Ticket', proposal.ticketId);
  if (proposal.requiresHumanApproval && ticket.status !== 'pending_approval') {
    throw new StateConflictError('Ticket is not waiting for approval');
  }

  const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const updatedProposal: ActionProposal = { ...proposal, status };
  const updatedTicket: SupportTicket = {
    ...ticket,
    status: input.decision === 'APPROVE' ? 'open' : 'rejected',
  };

  store.proposals.set(updatedProposal.id, updatedProposal);
  store.tickets.set(updatedTicket.id, updatedTicket);
  store.appendAudit('OPERATOR', `REFUND_${input.decision}`, proposal.id, {
    ticketId: ticket.id,
    operatorId: input.operatorId,
  }, input.operatorId);

  store.refundDecisionKeys.set(input.idempotencyKey, {
    fingerprint: requestFingerprint,
    proposal: { ...updatedProposal },
  });

  return { proposal: { ...updatedProposal }, replayed: false };
}
