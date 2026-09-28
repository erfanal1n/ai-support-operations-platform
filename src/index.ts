import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = buildApp();
let shutdownStarted = false;

function shutDown(signal: NodeJS.Signals): void {
  if (shutdownStarted) return;
  shutdownStarted = true;

  app.log.info({ signal }, 'Closing server');
  const deadline = setTimeout(() => {
    app.log.error('Server close timed out');
    process.exit(1);
  }, 10_000);
  deadline.unref();

  void app.close().then(
    () => clearTimeout(deadline),
    (err: unknown) => {
      clearTimeout(deadline);
      app.log.error({ err }, 'Failed to close server');
      process.exitCode = 1;
    }
  );
}

process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.error({ err }, 'Failed to start server');
  process.exitCode = 1;
}
