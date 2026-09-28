import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createSupportRepository } from './data/create-repository.js';
import type { SupportRepository } from './data/repository.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;
let repository: SupportRepository | undefined;
let shutdownStarted = false;

function shutDown(signal: NodeJS.Signals): void {
  if (shutdownStarted) return;
  shutdownStarted = true;

  const runningApp = app;
  if (!runningApp) return;

  runningApp.log.info({ signal }, 'Closing server');
  const deadline = setTimeout(() => {
    runningApp.log.error('Server close timed out');
    process.exit(1);
  }, 10_000);
  deadline.unref();

  void runningApp.close().then(
    () => clearTimeout(deadline),
    (err: unknown) => {
      clearTimeout(deadline);
      runningApp.log.error({ err }, 'Failed to close server');
      process.exitCode = 1;
    }
  );
}

process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);

try {
  repository = await createSupportRepository(env);
  const runningApp = buildApp(repository);
  app = runningApp;
  await runningApp.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  if (app) {
    app.log.error({ err }, 'Failed to start server');
  } else {
    process.stderr.write(`Failed to start server: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  }
  if (repository) await repository.close();
  process.exitCode = 1;
}
