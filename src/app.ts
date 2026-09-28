import Fastify from 'fastify';
import { z, type ZodIssue } from 'zod';
import { AppError, ValidationError } from './core/errors.js';
import { env } from './config/env.js';
import { db, MemoryStore } from './data/db.js';
import { decideRefundProposal } from './support/refund-decisions.js';
import { createRefundProposal } from './support/refund-proposals.js';
import { createTicket, getTicketContext, listTickets } from './support/tickets.js';

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
    operatorId: z.string().trim().min(1).max(120),
  })
  .strict();

function requestValidationError(message: string, issues: ZodIssue[]): ValidationError {
  return new ValidationError(
    message,
    issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  );
}

export function buildApp(store: MemoryStore = db) {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

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

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/tickets', async (request) => {
    const parsed = ticketListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw requestValidationError('Ticket query is invalid', parsed.error.issues);
    }

    return { tickets: listTickets(store, parsed.data.status) };
  });

  app.get('/api/tickets/:ticketId', async (request) => {
    const parsed = ticketParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw requestValidationError('Ticket ID is invalid', parsed.error.issues);
    }

    return getTicketContext(store, parsed.data.ticketId);
  });

  app.post('/api/tickets', async (request, reply) => {
    const parsed = createTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      throw requestValidationError('Ticket request is invalid', parsed.error.issues);
    }

    const ticket = createTicket(store, parsed.data);
    return reply.code(201).send({ ticket });
  });

  app.post('/api/tickets/:ticketId/refund-proposals', async (request, reply) => {
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

    const result = createRefundProposal(store, {
      ...body.data,
      ticketId: params.data.ticketId,
      idempotencyKey: key.data,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post('/api/refund-proposals/:proposalId/decision', async (request, reply) => {
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

    const result = decideRefundProposal(store, {
      ...body.data,
      proposalId: params.data.proposalId,
      idempotencyKey: key.data,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  return app;
}
