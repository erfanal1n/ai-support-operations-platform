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

export interface SupportRepository extends TicketTriageDataSource {
  health(): Promise<void>;
  close(): Promise<void>;
  listTickets(status?: TicketStatus): Promise<TicketListEntry[]>;
  getTicketContext(ticketId: string, policyHits: PolicySearchHit[]): Promise<TicketContext>;
  createTicket(input: CreateTicketInput): Promise<SupportTicket>;
  createRefundProposal(input: CreateRefundProposalInput): Promise<CreateRefundProposalResult>;
  decideRefundProposal(input: DecideRefundProposalInput): Promise<RefundDecisionResult>;
  executeRefundProposal(input: ExecuteRefundInput): Promise<ExecuteRefundResult>;
}
