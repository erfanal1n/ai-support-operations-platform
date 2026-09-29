export type TicketStatus = 'open' | 'pending_approval' | 'resolved' | 'rejected';
export type CustomerTier = 'free' | 'starter' | 'enterprise';

export interface TicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  customer: { id: string; name: string; tier: CustomerTier };
}

export interface TicketContext {
  ticket: {
    id: string;
    customerId: string;
    subject: string;
    rawMessage: string;
    status: TicketStatus;
    createdAt: string;
    resolvedAt?: string;
  };
  customer: { id: string; name: string; tier: CustomerTier; tenureDays: number };
  invoices: Array<{
    id: string;
    amountCents: number;
    refundedAmountCents: number;
    currency: string;
    status: 'paid' | 'partially_refunded' | 'refunded' | 'disputed';
    issuedAt: string;
  }>;
  relevantPolicies: Array<{
    id: string;
    category: string;
    title: string;
    summary: string;
    fullText: string;
    matchedKeywords: string[];
  }>;
  proposals: Array<{
    id: string;
    actionType: string;
    status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTED';
    amountCents?: number;
    targetInvoiceId?: string;
    matchedPolicyId: string;
    requiresHumanApproval: boolean;
    approvalReason?: string;
    createdAt: string;
    executedAt?: string;
  }>;
}

export interface TicketTriageResult {
  summary: string;
  replyDraft: string;
  recommendedAction: 'refund_review' | 'manual_review' | 'no_action';
  decisionBasis: string;
  policyIds: string[];
  invoiceIds: string[];
  requiresHumanReview: true;
  metrics: {
    durationMs: number;
    modelCalls: number;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
  };
}
