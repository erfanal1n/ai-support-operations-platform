import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../core/errors.js';
import type {
  ActionType,
  CustomerProfile,
  InvoiceStatus,
  ProposalStatus,
  SupportTicket,
  TicketStatus,
} from '../core/types.js';
import type { MemoryStore } from '../data/db.js';
import { searchPolicies } from './policy-search.js';

export interface TicketListEntry {
  id: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  customer: Pick<CustomerProfile, 'id' | 'name' | 'tier'>;
}

export interface TicketContext {
  ticket: SupportTicket;
  customer: Pick<CustomerProfile, 'id' | 'name' | 'tier' | 'tenureDays'>;
  invoices: Array<{
    id: string;
    amountCents: number;
    refundedAmountCents: number;
    currency: string;
    status: InvoiceStatus;
    issuedAt: string;
  }>;
  relevantPolicies: Array<{
    id: string;
    title: string;
    summary: string;
    fullText: string;
    matchedKeywords: string[];
  }>;
  proposals: Array<{ id: string; actionType: ActionType; status: ProposalStatus; amountCents?: number }>;
}

export interface CreateTicketInput {
  customerId: string;
  subject: string;
  rawMessage: string;
}

export function createTicket(
  store: MemoryStore,
  input: CreateTicketInput,
  createdAt = new Date()
): SupportTicket {
  if (!store.customers.has(input.customerId)) {
    throw new NotFoundError('Customer', input.customerId);
  }

  const ticket: SupportTicket = {
    id: `ticket_${randomUUID()}`,
    customerId: input.customerId,
    subject: input.subject,
    rawMessage: input.rawMessage,
    status: 'open',
    createdAt: createdAt.toISOString(),
  };

  store.tickets.set(ticket.id, ticket);
  store.appendAudit('SYSTEM', 'TICKET_CREATED', ticket.id, { customerId: input.customerId });

  return ticket;
}

export function listTickets(store: MemoryStore, status?: TicketStatus): TicketListEntry[] {
  return [...store.tickets.values()]
    .filter((ticket) => status === undefined || ticket.status === status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .map((ticket) => {
      const customer = store.customers.get(ticket.customerId);
      if (!customer) throw new NotFoundError('Customer', ticket.customerId);

      return {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        createdAt: ticket.createdAt,
        customer: { id: customer.id, name: customer.name, tier: customer.tier },
      };
    });
}

export function getTicketContext(store: MemoryStore, ticketId: string): TicketContext {
  const ticket = store.tickets.get(ticketId);
  if (!ticket) throw new NotFoundError('Ticket', ticketId);

  const customer = store.customers.get(ticket.customerId);
  if (!customer) throw new NotFoundError('Customer', ticket.customerId);

  const relevantPolicies = searchPolicies(store.policies.values(), ticket.rawMessage).map(
    ({ policy, matchedKeywords }) => ({
      id: policy.id,
      title: policy.title,
      summary: policy.summary,
      fullText: policy.fullText,
      matchedKeywords,
    })
  );

  return {
    ticket,
    customer: {
      id: customer.id,
      name: customer.name,
      tier: customer.tier,
      tenureDays: customer.tenureDays,
    },
    invoices: [...store.invoices.values()]
      .filter((invoice) => invoice.customerId === customer.id)
      .map(({ id, amountCents, refundedAmountCents, currency, status, issuedAt }) => ({
        id,
        amountCents,
        refundedAmountCents,
        currency,
        status,
        issuedAt,
      })),
    relevantPolicies,
    proposals: [...store.proposals.values()]
      .filter((proposal) => proposal.ticketId === ticket.id)
      .map(({ id, actionType, status, amountCents }) => ({ id, actionType, status, amountCents })),
  };
}
