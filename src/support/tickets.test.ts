import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../core/errors.js';
import { MemoryStore } from '../data/db.js';
import { createTicket, getTicketContext, listTickets } from './tickets.js';

describe('createTicket', () => {
  it('creates an open ticket and records the creation', () => {
    const store = new MemoryStore();
    const startingTicketCount = store.tickets.size;
    const ticket = createTicket(
      store,
      {
        customerId: 'cust_acme_corp',
        subject: 'Duplicate charge',
        rawMessage: 'I see two charges for this month.',
      },
      new Date('2026-09-28T00:00:00.000Z')
    );

    expect(ticket).toMatchObject({
      customerId: 'cust_acme_corp',
      subject: 'Duplicate charge',
      rawMessage: 'I see two charges for this month.',
      status: 'open',
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    expect(store.tickets.get(ticket.id)).toEqual(ticket);
    expect(store.tickets.size).toBe(startingTicketCount + 1);
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]).toMatchObject({
      actor: 'SYSTEM',
      actionType: 'TICKET_CREATED',
      entityId: ticket.id,
    });
  });

  it('leaves the store unchanged when the customer is missing', () => {
    const store = new MemoryStore();
    const startingTickets = [...store.tickets.values()];

    expect(() =>
      createTicket(store, {
        customerId: 'cust_unknown',
        subject: 'Billing question',
        rawMessage: 'Please check my invoice.',
      })
    ).toThrow(NotFoundError);
    expect([...store.tickets.values()]).toEqual(startingTickets);
    expect(store.auditLogs).toHaveLength(0);
  });

  it('lists newest tickets with a small customer summary', () => {
    const store = new MemoryStore();
    const tickets = listTickets(store);

    expect(tickets).toHaveLength(3);
    expect(tickets[0]).toMatchObject({
      id: 'ticket_solo_duplicate_charge',
      customer: { id: 'cust_solo_dev', name: 'Alex Rivera', tier: 'starter' },
    });
    expect(tickets[0]).not.toHaveProperty('rawMessage');
    expect(listTickets(store, 'pending_approval')).toEqual([]);
  });

  it('returns the ticket, customer, matching invoices, and policy evidence', () => {
    const store = new MemoryStore();
    const context = getTicketContext(store, 'ticket_solo_duplicate_charge');

    expect(context.customer).toMatchObject({ id: 'cust_solo_dev', tenureDays: 12 });
    expect(context.invoices.map((invoice) => invoice.id)).toEqual(['inv_solo_001', 'inv_solo_002']);
    expect(context.relevantPolicies[0]).toMatchObject({
      id: 'POL-REFUND-STANDARD',
      matchedKeywords: ['charged twice'],
    });
  });

  it('returns not found for an unknown ticket', () => {
    expect(() => getTicketContext(new MemoryStore(), 'ticket_missing')).toThrow(NotFoundError);
  });
});
