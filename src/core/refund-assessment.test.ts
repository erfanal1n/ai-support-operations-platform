import { describe, expect, it } from 'vitest';
import { assessRefund } from './refund-assessment.js';
import type { CustomerProfile, InvoiceRecord, PolicyRule } from './types.js';

const now = new Date('2026-09-28T00:00:00.000Z');

const customer: CustomerProfile = {
  id: 'cust_acme_corp',
  email: 'billing@acmewidgets.com',
  name: 'Acme Widgets Ltd',
  tenureDays: 140,
  tier: 'enterprise',
  riskScore: 5,
};

const invoice: InvoiceRecord = {
  id: 'inv_acme_001',
  customerId: customer.id,
  amountCents: 4900,
  refundedAmountCents: 0,
  currency: 'USD',
  status: 'paid',
  issuedAt: '2026-09-24T00:00:00.000Z',
};

const policy: PolicyRule = {
  id: 'POL-REFUND-STANDARD',
  category: 'refund',
  title: 'Standard Subscription Refund Policy',
  summary: 'Refunds permitted within 14 days.',
  fullText: 'Automatic approval is limited to $50.00 and accounts must be at least 30 days old.',
  maxAutoApprovedCents: 5000,
  minTenureDays: 30,
  refundWindowDays: 14,
  keywords: ['refund'],
};

describe('assessRefund', () => {
  it('auto-approves a refund inside the policy limits', () => {
    expect(assessRefund({ customer, invoice, policy, amountCents: 4900, now })).toEqual({
      disposition: 'AUTO_APPROVABLE',
    });
  });

  it('requires approval for amounts or account tenure outside auto-approval limits', () => {
    const newCustomer = { ...customer, tenureDays: 12 };
    const largerInvoice = { ...invoice, amountCents: 18000 };

    expect(
      assessRefund({ customer: newCustomer, invoice: largerInvoice, policy, amountCents: 12000, now })
    ).toEqual({
      disposition: 'REQUIRES_APPROVAL',
      reasons: ['AMOUNT_ABOVE_AUTO_APPROVAL_LIMIT', 'CUSTOMER_TENURE_BELOW_MINIMUM'],
    });
  });

  it('rejects a refund against another customer’s invoice', () => {
    expect(
      assessRefund({ customer: { ...customer, id: 'cust_other' }, invoice, policy, amountCents: 1000, now })
    ).toEqual({ disposition: 'REJECTED', reason: 'CUSTOMER_INVOICE_MISMATCH' });
  });

  it('rejects a refund that exceeds the remaining invoice balance', () => {
    const partialRefund = { ...invoice, status: 'partially_refunded' as const, refundedAmountCents: 3000 };

    expect(assessRefund({ customer, invoice: partialRefund, policy, amountCents: 2000, now })).toEqual({
      disposition: 'REJECTED',
      reason: 'REFUND_EXCEEDS_REMAINING_BALANCE',
    });
  });

  it('rejects disputed and already refunded invoices', () => {
    const disputed = { ...invoice, status: 'disputed' as const };
    const refunded = { ...invoice, status: 'refunded' as const, refundedAmountCents: invoice.amountCents };

    expect(assessRefund({ customer, invoice: disputed, policy, amountCents: 1000, now })).toEqual({
      disposition: 'REJECTED',
      reason: 'INVOICE_DISPUTED',
    });
    expect(assessRefund({ customer, invoice: refunded, policy, amountCents: 1000, now })).toEqual({
      disposition: 'REJECTED',
      reason: 'INVOICE_ALREADY_REFUNDED',
    });
  });

  it('rejects invalid and expired refund requests', () => {
    const expired = { ...invoice, issuedAt: '2026-09-01T00:00:00.000Z' };

    expect(assessRefund({ customer, invoice, policy, amountCents: 0, now })).toEqual({
      disposition: 'REJECTED',
      reason: 'INVALID_AMOUNT',
    });
    expect(assessRefund({ customer, invoice: expired, policy, amountCents: 1000, now })).toEqual({
      disposition: 'REJECTED',
      reason: 'OUTSIDE_REFUND_WINDOW',
    });
  });

  it('fails closed when customer tenure or the machine-readable policy rule is missing', () => {
    const missingWindow = { ...policy, refundWindowDays: undefined };
    const invalidTenure = { ...customer, tenureDays: Number.NaN };

    expect(assessRefund({ customer: invalidTenure, invoice, policy, amountCents: 1000, now })).toEqual({
      disposition: 'REJECTED',
      reason: 'INVALID_CUSTOMER_TENURE',
    });
    expect(assessRefund({ customer, invoice, policy: missingWindow, amountCents: 1000, now })).toEqual({
      disposition: 'REQUIRES_APPROVAL',
      reasons: ['POLICY_RULE_INCOMPLETE'],
    });
  });
});
