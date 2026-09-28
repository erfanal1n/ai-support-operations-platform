import { createHash } from 'node:crypto';
import {
  ApprovalRequiredError,
  IdempotencyConflictError,
  NotFoundError,
  PolicyMismatchError,
  StateConflictError,
} from '../core/errors.js';
import type { ActionProposal, InvoiceRecord, SupportTicket } from '../core/types.js';
import type { MemoryStore } from '../data/db.js';
import { assessRefund } from '../core/refund-assessment.js';

export interface ExecuteRefundInput {
  proposalId: string;
  idempotencyKey: string;
}

export interface ExecuteRefundResult {
  proposal: ActionProposal;
  invoice: InvoiceRecord;
  replayed: boolean;
}

function fingerprint(proposalId: string): string {
  return createHash('sha256').update(proposalId).digest('hex');
}

export function executeRefundProposal(
  store: MemoryStore,
  input: ExecuteRefundInput,
  now = new Date()
): ExecuteRefundResult {
  const requestFingerprint = fingerprint(input.proposalId);
  const previousExecution = store.refundExecutionKeys.get(input.idempotencyKey);

  if (previousExecution) {
    if (previousExecution.fingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError();
    }
    return {
      proposal: { ...previousExecution.proposal },
      invoice: { ...previousExecution.invoice },
      replayed: true,
    };
  }

  const proposal = store.proposals.get(input.proposalId);
  if (!proposal) throw new NotFoundError('Refund proposal', input.proposalId);
  if (proposal.actionType !== 'ISSUE_REFUND' || !proposal.targetInvoiceId || proposal.amountCents === undefined) {
    throw new StateConflictError('Proposal is not a complete refund action');
  }
  if (proposal.status !== 'PROPOSED' && proposal.status !== 'APPROVED') {
    throw new StateConflictError('Refund proposal cannot be executed in its current state');
  }

  const ticket = store.tickets.get(proposal.ticketId);
  if (!ticket) throw new NotFoundError('Ticket', proposal.ticketId);

  const customer = store.customers.get(proposal.customerId);
  if (!customer) throw new NotFoundError('Customer', proposal.customerId);

  const invoice = store.invoices.get(proposal.targetInvoiceId);
  if (!invoice) throw new NotFoundError('Invoice', proposal.targetInvoiceId);

  const policy = store.policies.get(proposal.matchedPolicyId);
  if (!policy) throw new NotFoundError('Policy', proposal.matchedPolicyId);

  const assessment = assessRefund({ customer, invoice, policy, amountCents: proposal.amountCents, now });
  if (assessment.disposition === 'REJECTED') {
    store.appendAudit('SYSTEM', 'REFUND_EXECUTION_REJECTED', proposal.id, {
      invoiceId: invoice.id,
      reason: assessment.reason,
    });
    throw new PolicyMismatchError(assessment.reason);
  }

  if (assessment.disposition === 'REQUIRES_APPROVAL' && proposal.status === 'PROPOSED') {
    if (!proposal.requiresHumanApproval) {
      const updatedProposal = {
        ...proposal,
        requiresHumanApproval: true,
        approvalReason: assessment.reasons.join(', '),
      };
      store.proposals.set(proposal.id, updatedProposal);
      store.tickets.set(ticket.id, { ...ticket, status: 'pending_approval' });
      store.appendAudit('SYSTEM', 'REFUND_REQUIRES_APPROVAL', proposal.id, {
        ticketId: ticket.id,
        reasons: assessment.reasons,
      });
    }
    throw new ApprovalRequiredError(proposal.id, assessment.reasons.join(', '));
  }

  if (proposal.requiresHumanApproval && proposal.status !== 'APPROVED') {
    throw new ApprovalRequiredError(proposal.id, proposal.approvalReason ?? 'operator approval is missing');
  }

  const refundedAmountCents = invoice.refundedAmountCents + proposal.amountCents;
  const updatedInvoice: InvoiceRecord = {
    ...invoice,
    refundedAmountCents,
    status: refundedAmountCents === invoice.amountCents ? 'refunded' : 'partially_refunded',
  };
  const executedAt = now.toISOString();
  const updatedProposal: ActionProposal = { ...proposal, status: 'EXECUTED', executedAt };
  const unresolvedProposals = [...store.proposals.values()].filter(
    (candidate) =>
      candidate.ticketId === ticket.id &&
      candidate.id !== proposal.id &&
      (candidate.status === 'PROPOSED' || candidate.status === 'APPROVED')
  );
  const hasPendingApproval = unresolvedProposals.some(
    (candidate) => candidate.requiresHumanApproval && candidate.status === 'PROPOSED'
  );
  const ticketStatus = hasPendingApproval
    ? 'pending_approval'
    : unresolvedProposals.length > 0
      ? 'open'
      : 'resolved';
  const updatedTicket: SupportTicket = {
    ...ticket,
    status: ticketStatus,
    resolvedAt: ticketStatus === 'resolved' ? executedAt : undefined,
  };

  store.invoices.set(updatedInvoice.id, updatedInvoice);
  store.proposals.set(updatedProposal.id, updatedProposal);
  store.tickets.set(updatedTicket.id, updatedTicket);
  store.appendAudit('SYSTEM', 'REFUND_EXECUTED', proposal.id, {
    ticketId: ticket.id,
    invoiceId: invoice.id,
    amountCents: proposal.amountCents,
    refundedAmountCents,
  });

  store.refundExecutionKeys.set(input.idempotencyKey, {
    fingerprint: requestFingerprint,
    proposal: { ...updatedProposal },
    invoice: { ...updatedInvoice },
  });

  return { proposal: { ...updatedProposal }, invoice: { ...updatedInvoice }, replayed: false };
}
