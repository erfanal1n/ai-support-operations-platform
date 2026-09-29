import Fastify, { type FastifyRequest } from 'fastify';
import { z, type ZodIssue } from 'zod';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  StateConflictError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from './core/errors.js';
import { env } from './config/env.js';
import { db, MemoryStore } from './data/db.js';
import { MemorySupportRepository } from './data/memory-repository.js';
import type { SupportRepository } from './data/repository.js';
import {
  authenticateOperator,
  clearSessionCookie,
  createSession,
  credentialFingerprint,
  loginAttemptKey,
  readSession,
} from './auth/session.js';
import { TicketTriageAgent } from './ai/ticket-triage.js';
import { createPolicySearch } from './support/policy-retrieval.js';
import type { PolicySearchEngine } from './support/policy-search.js';

const createTicketSchema = z
  .object({
    customerId: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(3).max(180),
    rawMessage: z.string().trim().min(1).max(5000),
  })
  .strict();
const ticketListQuerySchema = z
  .object({ status: z.enum(['open', 'pending_approval', 'resolved', 'rejected']).optional() })
  .strict();
const ticketParamsSchema = z.object({ ticketId: z.string().trim().min(1).max(120) }).strict();
const refundProposalSchema = z
  .object({
    invoiceId: z.string().trim().min(1).max(120),
    policyId: z.string().trim().min(1).max(120),
    amountCents: z.number().int().safe().positive(),
  })
  .strict();
const idempotencyKeySchema = z.string().trim().min(16).max(200);
const refundProposalParamsSchema = z.object({ proposalId: z.string().trim().min(1).max(120) }).strict();
const refundDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    operatorId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
const loginSchema = z.object({
  id: z.string().trim().min(1).max(120),
  token: z.string().min(1).max(512),
}).strict();
const loginWindowSeconds = 15 * 60;
const maxLoginAttempts = 5;

function requireAgent(request: FastifyRequest): void {
  if (env.AUTH_MODE === 'session' && !request.operator) throw new UnauthorizedError();
}

function requireSupervisor(request: FastifyRequest): void {
  requireAgent(request);
  if (env.AUTH_MODE === 'session' && request.operator?.role !== 'supervisor') throw new ForbiddenError();
}

async function requestOperator(request: FastifyRequest, repository: SupportRepository) {
  if (env.AUTH_MODE !== 'session') return null;
  const signed = readSession(request.headers.cookie, env.SESSION_SECRET ?? '');
  if (!signed) return null;

  const session = await repository.getOperatorSession(signed.sessionHash);
  if (!session || session.expiresAt !== signed.expiresAt) return null;

  const credential = env.SUPPORT_OPERATOR_TOKENS.find(({ id }) => id === session.operatorId);
  if (!credential || credentialFingerprint(credential.token) !== session.credentialHash) return null;
  return { id: credential.id, role: credential.role };
}

function requestValidationError(message: string, issues: ZodIssue[]): ValidationError {
  return new ValidationError(
    message,
    issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  );
}

export function buildApp(
  source: MemoryStore | SupportRepository = db,
  policySearch: PolicySearchEngine = createPolicySearch(env)
) {
  const repository = source instanceof MemoryStore ? new MemorySupportRepository(source) : source;
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });
  const triageAgent = env.AI_TRIAGE_MODE === 'openai' && env.OPENAI_API_KEY
    ? new TicketTriageAgent(env.OPENAI_API_KEY, env.OPENAI_TRIAGE_MODEL, repository, policySearch)
    : undefined;

  app.decorateRequest('operator', null);
  app.addHook('onClose', async () => repository.close());

  const publicRequests = new Set([
    'GET /health',
    'GET /api/session',
    'POST /api/session/login',
    'POST /api/session/logout',
  ]);
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    if (env.AUTH_MODE !== 'session' || publicRequests.has(`${request.method} ${path}`)) return;

    request.operator = await requestOperator(request, repository);
    if (!request.operator) throw new UnauthorizedError();
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      });
    }

    if (err.statusCode !== undefined && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: { code: `E_HTTP_${err.statusCode}`, message: 'Invalid request' },
      });
    }

    request.log.error({ err }, 'Unhandled request error');
    return reply.code(500).send({
      error: { code: 'E_INTERNAL', message: 'Internal server error' },
    });
  });

  app.get('/health', async () => {
    await repository.health();
    return { status: 'ok' };
  });

  app.get('/api/session', async (request) => ({
    authRequired: env.AUTH_MODE === 'session',
    operator: await requestOperator(request, repository),
    triageEnabled: Boolean(triageAgent),
  }));

  app.post('/api/session/login', async (request, reply) => {
    if (env.AUTH_MODE !== 'session') throw new StateConflictError('Session authentication is not enabled');

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw requestValidationError('Login request is invalid', parsed.error.issues);

    const attemptKey = loginAttemptKey(request.ip, parsed.data.id, env.SESSION_SECRET ?? '');
    const attempt = await repository.consumeLoginAttempt(attemptKey, loginWindowSeconds, maxLoginAttempts);
    if (!attempt.allowed) {
      reply.header('Retry-After', String(attempt.retryAfterSeconds));
      throw new TooManyRequestsError();
    }

    const operator = authenticateOperator(parsed.data.id, parsed.data.token, env.SUPPORT_OPERATOR_TOKENS);
    if (!operator) throw new UnauthorizedError('Operator ID or token is invalid');
    const credential = env.SUPPORT_OPERATOR_TOKENS.find(({ id }) => id === operator.id)!;
    const session = createSession(credential, env.SESSION_SECRET ?? '', env.NODE_ENV === 'production');

    await repository.createOperatorSession(session);
    await repository.clearLoginAttempts(attemptKey);
    reply.header('Set-Cookie', session.cookie);
    return { operator };
  });

  app.post('/api/session/logout', async (request, reply) => {
    const session = readSession(request.headers.cookie, env.SESSION_SECRET ?? '');
    if (session) await repository.deleteOperatorSession(session.sessionHash);
    reply.header('Set-Cookie', clearSessionCookie(env.NODE_ENV === 'production'));
    return { ok: true };
  });

  app.get('/api/tickets', async (request) => {
    requireAgent(request);
    const parsed = ticketListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw requestValidationError('Ticket query is invalid', parsed.error.issues);
    }

    return { tickets: await repository.listTickets(parsed.data.status) };
  });

  app.get('/api/tickets/:ticketId', async (request) => {
    requireAgent(request);
    const parsed = ticketParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw requestValidationError('Ticket ID is invalid', parsed.error.issues);
    }

    const ticket = await repository.getTicket(parsed.data.ticketId);
    if (!ticket) throw new NotFoundError('Ticket', parsed.data.ticketId);

    let hits;
    try {
      hits = await policySearch.search(await repository.listPolicies(), ticket.rawMessage);
    } catch {
      request.log.error('Policy retrieval failed');
      throw new ServiceUnavailableError('Policy retrieval is temporarily unavailable');
    }

    return repository.getTicketContext(parsed.data.ticketId, hits);
  });

  app.post('/api/tickets/:ticketId/triage', async (request) => {
    requireAgent(request);
    const parsed = ticketParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw requestValidationError('Ticket ID is invalid', parsed.error.issues);
    }

    if (!await repository.getTicket(parsed.data.ticketId)) throw new NotFoundError('Ticket', parsed.data.ticketId);
    if (!triageAgent) throw new ServiceUnavailableError('AI ticket triage is not enabled');

    try {
      return { triage: await triageAgent.triage(parsed.data.ticketId) };
    } catch (err) {
      request.log.error({ err }, 'Ticket triage failed');
      throw new ServiceUnavailableError('Ticket triage is temporarily unavailable');
    }
  });

  app.post('/api/tickets', async (request, reply) => {
    requireAgent(request);
    const parsed = createTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      throw requestValidationError('Ticket request is invalid', parsed.error.issues);
    }

    const ticket = await repository.createTicket(parsed.data);
    return reply.code(201).send({ ticket });
  });

  app.post('/api/tickets/:ticketId/refund-proposals', async (request, reply) => {
    requireAgent(request);
    const params = ticketParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw requestValidationError('Ticket ID is invalid', params.error.issues);
    }

    const body = refundProposalSchema.safeParse(request.body);
    if (!body.success) {
      throw requestValidationError('Refund proposal is invalid', body.error.issues);
    }

    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!key.success) {
      throw requestValidationError('Idempotency-Key header is required', key.error.issues);
    }

    const result = await repository.createRefundProposal({
      ...body.data,
      ticketId: params.data.ticketId,
      idempotencyKey: key.data,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post('/api/refund-proposals/:proposalId/decision', async (request, reply) => {
    requireSupervisor(request);
    const params = refundProposalParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw requestValidationError('Refund proposal ID is invalid', params.error.issues);
    }

    const body = refundDecisionSchema.safeParse(request.body);
    if (!body.success) {
      throw requestValidationError('Refund decision is invalid', body.error.issues);
    }

    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!key.success) {
      throw requestValidationError('Idempotency-Key header is required', key.error.issues);
    }

    const operatorId = request.operator?.id ?? body.data.operatorId;
    if (!operatorId) throw requestValidationError('Operator ID is required', []);

    const result = await repository.decideRefundProposal({
      ...body.data,
      operatorId,
      proposalId: params.data.proposalId,
      idempotencyKey: key.data,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post('/api/refund-proposals/:proposalId/execute', async (request, reply) => {
    requireSupervisor(request);
    const params = refundProposalParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw requestValidationError('Refund proposal ID is invalid', params.error.issues);
    }

    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!key.success) {
      throw requestValidationError('Idempotency-Key header is required', key.error.issues);
    }

    const result = await repository.executeRefundProposal({
      proposalId: params.data.proposalId,
      idempotencyKey: key.data,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  return app;
}
