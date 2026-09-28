import type { CustomerProfile, InvoiceRecord, PolicyRule } from './types.js';

export type RefundApprovalReason =
  | 'AMOUNT_ABOVE_AUTO_APPROVAL_LIMIT'
  | 'CUSTOMER_TENURE_BELOW_MINIMUM'
  | 'POLICY_RULE_INCOMPLETE';

export type RefundRejectionReason =
  | 'INVALID_AMOUNT'
  | 'INVALID_INVOICE_STATE'
  | 'INVALID_CUSTOMER_TENURE'
  | 'INVOICE_DISPUTED'
  | 'CUSTOMER_INVOICE_MISMATCH'
  | 'POLICY_NOT_FOR_REFUNDS'
  | 'INVALID_REVIEW_DATE'
  | 'INVALID_INVOICE_DATE'
  | 'INVOICE_ALREADY_REFUNDED'
  | 'REFUND_EXCEEDS_REMAINING_BALANCE'
  | 'OUTSIDE_REFUND_WINDOW';

export type RefundAssessment =
  | { disposition: 'AUTO_APPROVABLE' }
  | { disposition: 'REQUIRES_APPROVAL'; reasons: RefundApprovalReason[] }
  | { disposition: 'REJECTED'; reason: RefundRejectionReason };

export interface RefundAssessmentInput {
  customer: CustomerProfile;
  invoice: InvoiceRecord;
  policy: PolicyRule;
  amountCents: number;
  now?: Date;
}

const dayInMs = 86_400_000;

function isValidInvoiceState(invoice: InvoiceRecord): boolean {
  if (
    !Number.isSafeInteger(invoice.amountCents) ||
    !Number.isSafeInteger(invoice.refundedAmountCents) ||
    invoice.amountCents <= 0 ||
    invoice.refundedAmountCents < 0 ||
    invoice.refundedAmountCents > invoice.amountCents
  ) {
    return false;
  }

  switch (invoice.status) {
    case 'paid':
      return invoice.refundedAmountCents === 0;
    case 'partially_refunded':
      return invoice.refundedAmountCents > 0 && invoice.refundedAmountCents < invoice.amountCents;
    case 'refunded':
      return invoice.refundedAmountCents === invoice.amountCents;
    case 'disputed':
      return true;
    default:
      return false;
  }
}

export function assessRefund({
  amountCents,
  customer,
  invoice,
  policy,
  now = new Date(),
}: RefundAssessmentInput): RefundAssessment {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { disposition: 'REJECTED', reason: 'INVALID_AMOUNT' };
  }

  if (!Number.isFinite(now.getTime())) {
    return { disposition: 'REJECTED', reason: 'INVALID_REVIEW_DATE' };
  }

  if (customer.id !== invoice.customerId) {
    return { disposition: 'REJECTED', reason: 'CUSTOMER_INVOICE_MISMATCH' };
  }

  if (!Number.isSafeInteger(customer.tenureDays) || customer.tenureDays < 0) {
    return { disposition: 'REJECTED', reason: 'INVALID_CUSTOMER_TENURE' };
  }

  if (policy.category !== 'refund') {
    return { disposition: 'REJECTED', reason: 'POLICY_NOT_FOR_REFUNDS' };
  }

  if (!isValidInvoiceState(invoice)) {
    return { disposition: 'REJECTED', reason: 'INVALID_INVOICE_STATE' };
  }

  if (invoice.status === 'disputed') {
    return { disposition: 'REJECTED', reason: 'INVOICE_DISPUTED' };
  }

  const remainingBalance = invoice.amountCents - invoice.refundedAmountCents;
  if (remainingBalance === 0) {
    return { disposition: 'REJECTED', reason: 'INVOICE_ALREADY_REFUNDED' };
  }

  if (amountCents > remainingBalance) {
    return { disposition: 'REJECTED', reason: 'REFUND_EXCEEDS_REMAINING_BALANCE' };
  }

  const issuedAt = Date.parse(invoice.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime()) {
    return { disposition: 'REJECTED', reason: 'INVALID_INVOICE_DATE' };
  }

  if (
    !Number.isSafeInteger(policy.maxAutoApprovedCents) ||
    policy.maxAutoApprovedCents < 0 ||
    !Number.isSafeInteger(policy.minTenureDays) ||
    policy.minTenureDays < 0 ||
    policy.refundWindowDays === undefined ||
    !Number.isSafeInteger(policy.refundWindowDays) ||
    policy.refundWindowDays < 0
  ) {
    return { disposition: 'REQUIRES_APPROVAL', reasons: ['POLICY_RULE_INCOMPLETE'] };
  }

  if (now.getTime() - issuedAt > policy.refundWindowDays * dayInMs) {
    return { disposition: 'REJECTED', reason: 'OUTSIDE_REFUND_WINDOW' };
  }

  const reasons: RefundApprovalReason[] = [];
  if (amountCents > policy.maxAutoApprovedCents) {
    reasons.push('AMOUNT_ABOVE_AUTO_APPROVAL_LIMIT');
  }
  if (customer.tenureDays < policy.minTenureDays) {
    reasons.push('CUSTOMER_TENURE_BELOW_MINIMUM');
  }

  if (reasons.length > 0) {
    return { disposition: 'REQUIRES_APPROVAL', reasons };
  }

  return { disposition: 'AUTO_APPROVABLE' };
}
