export type PolicyCategory = 'refund' | 'cancellation' | 'account_tier' | 'dispute';

export interface PolicyRule {
  id: string;
  category: PolicyCategory;
  title: string;
  summary: string;
  fullText: string;
  maxAutoApprovedCents: number;
  minTenureDays: number;
  keywords: string[];
}

export type CustomerTier = 'free' | 'starter' | 'enterprise';

export interface CustomerProfile {
  id: string;
  email: string;
  name: string;
  tenureDays: number;
  tier: CustomerTier;
  riskScore: number;
}

export type InvoiceStatus = 'paid' | 'refunded' | 'disputed';

export interface InvoiceRecord {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  issuedAt: string;
}

export type TicketStatus = 'open' | 'pending_approval' | 'resolved' | 'rejected';

export interface SupportTicket {
  id: string;
  customerId: string;
  subject: string;
  rawMessage: string;
  status: TicketStatus;
  createdAt: string;
  resolvedAt?: string;
}

export type ActionType = 'ISSUE_REFUND' | 'EXTEND_TRIAL' | 'CREDIT_ACCOUNT' | 'ESCALATE_TIER2';
export type ProposalStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTED';

export interface ActionProposal {
  id: string;
  ticketId: string;
  customerId: string;
  actionType: ActionType;
  targetInvoiceId?: string;
  amountCents?: number;
  matchedPolicyId: string;
  policyCitation: string;
  requiresHumanApproval: boolean;
  approvalReason?: string;
  status: ProposalStatus;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: 'SYSTEM' | 'OPERATOR';
  operatorId?: string;
  actionType: string;
  entityId: string;
  details: Record<string, unknown>;
}
