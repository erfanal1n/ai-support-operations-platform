import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../core/errors.js';
import { MemoryStore } from '../data/db.js';
import { createTicket } from './tickets.js';

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
});
