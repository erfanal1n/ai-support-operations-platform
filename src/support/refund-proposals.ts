import { createHash, randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  NotFoundError,
  PolicyMismatchError,
  StateConflictError,
} from '../core/errors.js';
import type { ActionProposal } from '../core/types.js';
import type { MemoryStore } from '../data/db.js';
import { assessRefund } from '../core/refund-assessment.js';

export interface CreateRefundProposalInput {
  ticketId: string;
  invoiceId: string;
  policyId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface CreateRefundProposalResult {
  proposal: ActionProposal;
  replayed: boolean;
}

function fingerprint(input: CreateRefundProposalInput): string {
  const requestShape = [input.ticketId, input.invoiceId, input.policyId, input.amountCents];
  return createHash('sha256').update(JSON.stringify(requestShape)).digest('hex');
}

export function createRefundProposal(
  store: MemoryStore,
  input: CreateRefundProposalInput,
  now = new Date()
): CreateRefundProposalResult {
  const requestFingerprint = fingerprint(input);
  const previousRequest = store.refundProposalKeys.get(input.idempotencyKey);

  if (previousRequest) {
    if (previousRequest.fingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError();
    }

    return { proposal: { ...previousRequest.proposal }, replayed: true };
  }

  const ticket = store.tickets.get(input.ticketId);
  if (!ticket) throw new NotFoundError('Ticket', input.ticketId);
  if (ticket.status !== 'open') {
    throw new StateConflictError('Ticket is not open for a refund proposal');
  }

  const customer = store.customers.get(ticket.customerId);
  if (!customer) throw new NotFoundError('Customer', ticket.customerId);

  const invoice = store.invoices.get(input.invoiceId);
  if (!invoice) throw new NotFoundError('Invoice', input.invoiceId);

  const policy = store.policies.get(input.policyId);
  if (!policy) throw new NotFoundError('Policy', input.policyId);

  const unresolvedProposal = [...store.proposals.values()].find(
    (proposal) =>
      proposal.ticketId === ticket.id &&
      proposal.targetInvoiceId === invoice.id &&
      proposal.actionType === 'ISSUE_REFUND' &&
      (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED')
  );
  if (unresolvedProposal) {
    throw new StateConflictError('An unresolved refund proposal already exists for this invoice');
  }

  const assessment = assessRefund({ customer, invoice, policy, amountCents: input.amountCents, now });
  if (assessment.disposition === 'REJECTED') {
    store.appendAudit('SYSTEM', 'REFUND_ASSESSMENT_REJECTED', ticket.id, {
      invoiceId: invoice.id,
      policyId: policy.id,
      amountCents: input.amountCents,
      reason: assessment.reason,
    });
    throw new PolicyMismatchError(assessment.reason);
  }

  const requiresHumanApproval = assessment.disposition === 'REQUIRES_APPROVAL';
  const proposal: ActionProposal = {
    id: `proposal_${randomUUID()}`,
    ticketId: ticket.id,
    customerId: customer.id,
    actionType: 'ISSUE_REFUND',
    targetInvoiceId: invoice.id,
    amountCents: input.amountCents,
    matchedPolicyId: policy.id,
    policyCitation: policy.fullText,
    requiresHumanApproval,
    approvalReason: requiresHumanApproval ? assessment.reasons.join(', ') : undefined,
    status: 'PROPOSED',
    createdAt: now.toISOString(),
  };

  store.proposals.set(proposal.id, proposal);
  if (requiresHumanApproval) {
    store.tickets.set(ticket.id, { ...ticket, status: 'pending_approval' });
  }
  store.refundProposalKeys.set(input.idempotencyKey, {
    fingerprint: requestFingerprint,
    proposal: { ...proposal },
  });
  store.appendAudit('SYSTEM', 'REFUND_PROPOSED', proposal.id, {
    ticketId: ticket.id,
    invoiceId: invoice.id,
    policyId: policy.id,
    amountCents: input.amountCents,
    requiresHumanApproval,
  });

  return { proposal: { ...proposal }, replayed: false };
}
