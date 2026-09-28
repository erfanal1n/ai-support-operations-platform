import type {
  CreateRefundProposalInput,
  CreateRefundProposalResult,
} from '../support/refund-proposals.js';
import { createRefundProposal } from '../support/refund-proposals.js';
import type {
  DecideRefundProposalInput,
  RefundDecisionResult,
} from '../support/refund-decisions.js';
import { decideRefundProposal } from '../support/refund-decisions.js';
import type { ExecuteRefundInput, ExecuteRefundResult } from '../support/refund-execution.js';
import { executeRefundProposal } from '../support/refund-execution.js';
import type { PolicySearchHit } from '../support/policy-search.js';
import type { CreateTicketInput, TicketContext, TicketListEntry } from '../support/tickets.js';
import { createTicket, getTicketContext, listTickets } from '../support/tickets.js';
import type { MemoryStore } from './db.js';
import type { LoginAttemptResult, OperatorSessionRecord, SupportRepository } from './repository.js';
import type { TicketStatus } from '../core/types.js';

export class MemorySupportRepository implements SupportRepository {
  constructor(readonly store: MemoryStore) {}

  async health(): Promise<void> {}

  async close(): Promise<void> {}

  async createOperatorSession(session: OperatorSessionRecord): Promise<void> {
    for (const [id, current] of this.store.operatorSessions) {
      if (Date.parse(current.expiresAt) <= Date.now()) this.store.operatorSessions.delete(id);
    }
    this.store.operatorSessions.set(session.sessionHash, session);
  }

  async getOperatorSession(sessionHash: string): Promise<OperatorSessionRecord | null> {
    const session = this.store.operatorSessions.get(sessionHash);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      this.store.operatorSessions.delete(sessionHash);
      return null;
    }
    return session;
  }

  async deleteOperatorSession(sessionHash: string): Promise<void> {
    this.store.operatorSessions.delete(sessionHash);
  }

  async consumeLoginAttempt(key: string, windowSeconds: number, maxAttempts: number): Promise<LoginAttemptResult> {
    const now = Date.now();
    for (const [id, current] of this.store.loginAttempts) {
      if (current.windowStartedAt + windowSeconds * 1000 <= now) this.store.loginAttempts.delete(id);
    }

    const current = this.store.loginAttempts.get(key);
    const windowStartedAt = current && current.windowStartedAt + windowSeconds * 1000 > now
      ? current.windowStartedAt
      : now;
    const attempts = current && windowStartedAt === current.windowStartedAt ? current.attempts + 1 : 1;
    this.store.loginAttempts.set(key, { windowStartedAt, attempts });

    return {
      allowed: attempts <= maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + windowSeconds * 1000 - now) / 1000)),
    };
  }

  async clearLoginAttempts(key: string): Promise<void> {
    this.store.loginAttempts.delete(key);
  }

  async getTicket(id: string) {
    return this.store.getTicket(id);
  }

  async getCustomer(id: string) {
    return this.store.getCustomer(id);
  }

  async listCustomerInvoices(customerId: string) {
    return this.store.listCustomerInvoices(customerId);
  }

  async listPolicies() {
    return this.store.listPolicies();
  }

  async listTickets(status?: TicketStatus): Promise<TicketListEntry[]> {
    return listTickets(this.store, status);
  }

  async getTicketContext(ticketId: string, policyHits: PolicySearchHit[]): Promise<TicketContext> {
    return getTicketContext(this.store, ticketId, policyHits);
  }

  async createTicket(input: CreateTicketInput) {
    return createTicket(this.store, input);
  }

  async createRefundProposal(input: CreateRefundProposalInput): Promise<CreateRefundProposalResult> {
    return createRefundProposal(this.store, input);
  }

  async decideRefundProposal(input: DecideRefundProposalInput): Promise<RefundDecisionResult> {
    return decideRefundProposal(this.store, input);
  }

  async executeRefundProposal(input: ExecuteRefundInput): Promise<ExecuteRefundResult> {
    return executeRefundProposal(this.store, input);
  }
}
