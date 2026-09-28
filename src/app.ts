import Fastify from 'fastify';
import { env } from './config/env.js';

export function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
