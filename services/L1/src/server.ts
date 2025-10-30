import Fastify from 'fastify';
import { registerCacheRoutes } from './routes/cache';
import { registerSearchRoutes } from './routes/search';
import { getRedis } from './redis/client';

export async function buildApp() {
  const app = Fastify({ logger: false });

  app.get('/health', async () => {
    const redis = getRedis();
    try {
      await redis.ping();
      return { status: 'ok', redis: 'ok' };
    } catch {
      return { status: 'degraded', redis: 'error' };
    }
  });

  await registerCacheRoutes(app);
  await registerSearchRoutes(app);
  return app;
}
