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
    expect(store.tickets.size).toBe(1);
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
    expect(store.tickets.size).toBe(0);
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
    expect(store.tickets.size).toBe(0);
    expect(store.auditLogs).toHaveLength(0);
  });
});
