import type {
  CustomerProfile,
  InvoiceRecord,
  PolicyRule,
  SupportTicket,
  TicketStatus,
} from '../core/types.js';
import type {
  CreateRefundProposalInput,
  CreateRefundProposalResult,
} from '../support/refund-proposals.js';
import type {
  DecideRefundProposalInput,
  RefundDecisionResult,
} from '../support/refund-decisions.js';
import type { ExecuteRefundInput, ExecuteRefundResult } from '../support/refund-execution.js';
import type { PolicySearchHit } from '../support/policy-search.js';
import type { CreateTicketInput, TicketContext, TicketListEntry } from '../support/tickets.js';

export interface TicketTriageDataSource {
  getTicket(id: string): Promise<SupportTicket | null>;
  getCustomer(id: string): Promise<CustomerProfile | null>;
  listCustomerInvoices(customerId: string): Promise<InvoiceRecord[]>;
  listPolicies(): Promise<PolicyRule[]>;
}

export interface OperatorSessionRecord {
  sessionHash: string;
  operatorId: string;
  credentialHash: string;
  expiresAt: string;
}

export interface LoginAttemptResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface SupportRepository extends TicketTriageDataSource {
  health(): Promise<void>;
  close(): Promise<void>;
  createOperatorSession(session: OperatorSessionRecord): Promise<void>;
  getOperatorSession(sessionHash: string): Promise<OperatorSessionRecord | null>;
  deleteOperatorSession(sessionHash: string): Promise<void>;
  consumeLoginAttempt(key: string, windowSeconds: number, maxAttempts: number): Promise<LoginAttemptResult>;
  clearLoginAttempts(key: string): Promise<void>;
  listTickets(status?: TicketStatus): Promise<TicketListEntry[]>;
  getTicketContext(ticketId: string, policyHits: PolicySearchHit[]): Promise<TicketContext>;
  createTicket(input: CreateTicketInput): Promise<SupportTicket>;
  createRefundProposal(input: CreateRefundProposalInput): Promise<CreateRefundProposalResult>;
  decideRefundProposal(input: DecideRefundProposalInput): Promise<RefundDecisionResult>;
  executeRefundProposal(input: ExecuteRefundInput): Promise<ExecuteRefundResult>;
}
