import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { MemoryStore } from './data/db.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('health endpoint', () => {
  it('reports that the API is up', async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('accepts a valid ticket and records it with an audit entry', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: {
        customerId: 'cust_acme_corp',
        subject: 'Duplicate charge',
        rawMessage: 'I see two charges for this month.',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().ticket).toMatchObject({
      customerId: 'cust_acme_corp',
      subject: 'Duplicate charge',
      status: 'open',
    });
    expect(store.tickets.size).toBe(4);
    expect(store.auditLogs).toHaveLength(1);
  });

  it('rejects malformed ticket input without writing state', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: {
        customerId: 'cust_acme_corp',
        subject: '  ',
        rawMessage: 'Question',
        unexpected: true,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('E_VALIDATION_FAILED');
    expect(store.tickets.size).toBe(3);
    expect(store.auditLogs).toHaveLength(0);
  });

  it('does not create a ticket for an unknown customer', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: {
        customerId: 'cust_unknown',
        subject: 'Billing question',
        rawMessage: 'Please check my invoice.',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('E_NOT_FOUND');
    expect(store.tickets.size).toBe(3);
    expect(store.auditLogs).toHaveLength(0);
  });

  it('lists tickets and filters by status', async () => {
    const app = buildApp(new MemoryStore());
    apps.push(app);

    const allTickets = await app.inject({ method: 'GET', url: '/api/tickets' });
    const pendingTickets = await app.inject({ method: 'GET', url: '/api/tickets?status=pending_approval' });

    expect(allTickets.statusCode).toBe(200);
    expect(allTickets.json().tickets).toHaveLength(3);
    expect(pendingTickets.statusCode).toBe(200);
    expect(pendingTickets.json().tickets).toEqual([]);
  });

  it('returns ticket detail with invoice and policy evidence', async () => {
    const app = buildApp(new MemoryStore());
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/tickets/ticket_solo_duplicate_charge',
    });
    const ticketContext = response.json();

    expect(response.statusCode).toBe(200);
    expect(ticketContext.ticket.id).toBe('ticket_solo_duplicate_charge');
    expect(ticketContext.invoices).toHaveLength(2);
    expect(ticketContext.relevantPolicies[0].id).toBe('POL-REFUND-STANDARD');
  });

  it('rejects invalid queue filters and missing tickets', async () => {
    const app = buildApp(new MemoryStore());
    apps.push(app);

    const invalidFilter = await app.inject({ method: 'GET', url: '/api/tickets?status=waiting' });
    const missingTicket = await app.inject({ method: 'GET', url: '/api/tickets/ticket_missing' });

    expect(invalidFilter.statusCode).toBe(422);
    expect(missingTicket.statusCode).toBe(404);
  });

  it('creates and replays an idempotent refund proposal', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);
    const payload = {
      invoiceId: 'inv_solo_001',
      policyId: 'POL-REFUND-STANDARD',
      amountCents: 2900,
    };
    const headers = { 'idempotency-key': 'refund-proposal-solo-001' };
    const request = {
      method: 'POST' as const,
      url: '/api/tickets/ticket_solo_duplicate_charge/refund-proposals',
      headers,
      payload,
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);
    const conflict = await app.inject({ ...request, payload: { ...payload, amountCents: 2800 } });

    expect(first.statusCode).toBe(201);
    expect(first.json().proposal.requiresHumanApproval).toBe(true);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().proposal.id).toBe(first.json().proposal.id);
    expect(conflict.statusCode).toBe(409);
    expect(store.proposals.size).toBe(1);
    expect(store.tickets.get('ticket_solo_duplicate_charge')?.status).toBe('pending_approval');
    expect(store.auditLogs.filter(({ actionType }) => actionType === 'REFUND_PROPOSED')).toHaveLength(1);
  });

  it('requires an idempotency key before creating a refund proposal', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tickets/ticket_solo_duplicate_charge/refund-proposals',
      payload: {
        invoiceId: 'inv_solo_001',
        policyId: 'POL-REFUND-STANDARD',
        amountCents: 2900,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(store.proposals.size).toBe(0);
  });

  it('records an idempotent operator decision without executing the refund', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);
    const proposalResponse = await app.inject({
      method: 'POST',
      url: '/api/tickets/ticket_solo_duplicate_charge/refund-proposals',
      headers: { 'idempotency-key': 'refund-proposal-solo-001' },
      payload: {
        invoiceId: 'inv_solo_001',
        policyId: 'POL-REFUND-STANDARD',
        amountCents: 2900,
      },
    });
    const proposalId = proposalResponse.json().proposal.id as string;
    const decisionRequest = {
      method: 'POST' as const,
      url: `/api/refund-proposals/${proposalId}/decision`,
      headers: { 'idempotency-key': 'refund-approval-solo-001' },
      payload: { decision: 'APPROVE', operatorId: 'operator-17' },
    };

    const decision = await app.inject(decisionRequest);
    const replay = await app.inject(decisionRequest);

    expect(proposalResponse.statusCode).toBe(201);
    expect(decision.statusCode).toBe(201);
    expect(decision.json().proposal.status).toBe('APPROVED');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(store.invoices.get('inv_solo_001')?.refundedAmountCents).toBe(0);
    expect(store.tickets.get('ticket_solo_duplicate_charge')?.status).toBe('open');
    expect(store.auditLogs.filter(({ actionType }) => actionType === 'REFUND_APPROVE')).toHaveLength(1);
  });

  it('executes an approved refund once through the API', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);
    const proposalResponse = await app.inject({
      method: 'POST',
      url: '/api/tickets/ticket_solo_duplicate_charge/refund-proposals',
      headers: { 'idempotency-key': 'refund-proposal-solo-001' },
      payload: {
        invoiceId: 'inv_solo_001',
        policyId: 'POL-REFUND-STANDARD',
        amountCents: 2900,
      },
    });
    const proposalId = proposalResponse.json().proposal.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/refund-proposals/${proposalId}/decision`,
      headers: { 'idempotency-key': 'refund-approval-solo-001' },
      payload: { decision: 'APPROVE', operatorId: 'operator-17' },
    });
    const executeRequest = {
      method: 'POST' as const,
      url: `/api/refund-proposals/${proposalId}/execute`,
      headers: { 'idempotency-key': 'refund-execution-solo-001' },
    };

    const first = await app.inject(executeRequest);
    const replay = await app.inject(executeRequest);

    expect(first.statusCode).toBe(201);
    expect(first.json().proposal.status).toBe('EXECUTED');
    expect(first.json().invoice).toMatchObject({ refundedAmountCents: 2900, status: 'refunded' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(store.auditLogs.filter(({ actionType }) => actionType === 'REFUND_EXECUTED')).toHaveLength(1);
  });

  it('blocks execution of a proposal waiting for approval', async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    apps.push(app);
    const proposalResponse = await app.inject({
      method: 'POST',
      url: '/api/tickets/ticket_solo_duplicate_charge/refund-proposals',
      headers: { 'idempotency-key': 'refund-proposal-solo-001' },
      payload: {
        invoiceId: 'inv_solo_001',
        policyId: 'POL-REFUND-STANDARD',
        amountCents: 2900,
      },
    });
    const proposalId = proposalResponse.json().proposal.id as string;

    const response = await app.inject({
      method: 'POST',
      url: `/api/refund-proposals/${proposalId}/execute`,
      headers: { 'idempotency-key': 'refund-execution-solo-001' },
    });

    expect(response.statusCode).toBe(403);
    expect(store.invoices.get('inv_solo_001')?.refundedAmountCents).toBe(0);
  });
});
