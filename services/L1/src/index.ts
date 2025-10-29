import Fastify from 'fastify';
import { getRedis } from './redis/client';
import { config } from './config';
import { registerCacheRoutes } from './routes/cache';

/**
 * Main entrypoint for the L1 KV service.
 * Starts Fastify, registers health + cache routes, and listens on configured host/port.
 */
async function main() {
  const app = Fastify({ logger: true });

  // --- Health check route ---
  app.get('/health', async () => {
    const redis = getRedis();
    try {
      await redis.ping();
      return { status: 'ok', redis: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'Redis health check failed');
      return { status: 'degraded', redis: 'error' };
    }
  });

  // --- Core cache routes ---
  await registerCacheRoutes(app);

  // --- Start server ---
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`L1 KV server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error({ err }, 'Server startup failed');
    process.exit(1);
  }
}

// run
main().catch((err) => {
  // last-resort catch for any uncaught promise
  console.error('Fatal error starting L1 KV:', err);
  process.exit(1);
});
