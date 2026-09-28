import Fastify from 'fastify';
import { z } from 'zod';
import { AppError, ValidationError } from './core/errors.js';
import { env } from './config/env.js';
import { db, MemoryStore } from './data/db.js';
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
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError('Ticket query is invalid', details);
    }

    return { tickets: listTickets(store, parsed.data.status) };
  });

  app.get('/api/tickets/:ticketId', async (request) => {
    const parsed = ticketParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError('Ticket ID is invalid', details);
    }

    return getTicketContext(store, parsed.data.ticketId);
  });

  app.post('/api/tickets', async (request, reply) => {
    const parsed = createTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError('Ticket request is invalid', details);
    }

    const ticket = createTicket(store, parsed.data);
    return reply.code(201).send({ ticket });
  });

  return app;
}
