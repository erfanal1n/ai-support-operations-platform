import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MemoryStore } from './data/db.js';

const sessionSecret = 'auth-tests-use-a-private-session-secret-123';
const agentToken = 'agent-token-for-auth-tests-00000000001';
const supervisorToken = 'supervisor-token-for-auth-tests-00000000001';
const oldEnvironment = {
  AUTH_MODE: process.env.AUTH_MODE,
  SESSION_SECRET: process.env.SESSION_SECRET,
  SUPPORT_OPERATOR_TOKENS: process.env.SUPPORT_OPERATOR_TOKENS,
  STORAGE_MODE: process.env.STORAGE_MODE,
  LOG_LEVEL: process.env.LOG_LEVEL,
};

let createStore: () => MemoryStore;
let createApp: (store: MemoryStore) => FastifyInstance;
let app: FastifyInstance;

async function login(id: string, token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/session/login',
    payload: { id, token },
  });
}

function sessionCookie(response: Awaited<ReturnType<typeof login>>): string {
  const cookie = response.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('Login did not return a session cookie');
  return cookie.split(';', 1)[0]!;
}

beforeAll(async () => {
  process.env.AUTH_MODE = 'session';
  process.env.SESSION_SECRET = sessionSecret;
  process.env.STORAGE_MODE = 'memory';
  process.env.LOG_LEVEL = 'fatal';
  process.env.SUPPORT_OPERATOR_TOKENS = JSON.stringify([
    { id: 'agent-1', role: 'agent', token: agentToken },
    { id: 'supervisor-1', role: 'supervisor', token: supervisorToken },
  ]);

  vi.resetModules();
  const { MemoryStore } = await import('./data/db.js');
  const { buildApp } = await import('./app.js');
  createStore = () => new MemoryStore();
  createApp = (store) => buildApp(store);
});

afterAll(() => {
  for (const [key, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  app = createApp(createStore());
});

afterEach(async () => {
  await app.close();
});

describe('operator authentication', () => {
  it('limits a client after five failed sign-ins', async () => {
    const failures = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      failures.push((await login('agent-1', 'wrong-token')).statusCode);
    }

    const blocked = await login('agent-1', 'wrong-token');

    expect(failures).toEqual([401, 401, 401, 401, 401]);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.json().error.code).toBe('E_RATE_LIMITED');
  });

  it('clears failed attempts after a valid sign-in', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await login('agent-1', 'wrong-token')).statusCode).toBe(401);
    }
    expect((await login('agent-1', agentToken)).statusCode).toBe(200);

    const failures = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      failures.push((await login('agent-1', 'wrong-token')).statusCode);
    }
    const blocked = await login('agent-1', 'wrong-token');

    expect(failures).toEqual([401, 401, 401, 401, 401]);
    expect(blocked.statusCode).toBe(429);
  });

  it('keeps refund decisions limited to supervisors', async () => {
    const agentLogin = await login('agent-1', agentToken);
    const request = {
      method: 'POST' as const,
      url: '/api/refund-proposals/missing/decision',
      headers: { 'idempotency-key': 'auth-role-test-key-001' },
      payload: { decision: 'APPROVE' },
    };

    const denied = await app.inject({ ...request, headers: { ...request.headers, cookie: sessionCookie(agentLogin) } });
    const supervisorLogin = await login('supervisor-1', supervisorToken);
    const allowed = await app.inject({
      ...request,
      headers: { ...request.headers, cookie: sessionCookie(supervisorLogin) },
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(404);
  });

  it('revokes a session on logout', async () => {
    const signedIn = await login('agent-1', agentToken);
    const cookie = sessionCookie(signedIn);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: { cookie },
    });
    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie },
    });

    expect(logout.statusCode).toBe(200);
    expect(oldSession.statusCode).toBe(401);
  });
});
