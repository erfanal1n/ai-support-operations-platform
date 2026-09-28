import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../core/errors.js';
import type { SupportTicket } from '../core/types.js';
import { MemoryStore } from '../data/db.js';

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
