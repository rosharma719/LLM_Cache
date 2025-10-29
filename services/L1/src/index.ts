import Fastify from 'fastify';
import { getRedis } from './redis/client';
import { config } from './config';
import { registerCacheRoutes } from './routes/cache';

async function main() {
const app = Fastify({ logger: true });

app.get('/health', async () => {
const redis = getRedis();
try {
await redis.ping();
return { status: 'ok', redis: 'ok' };
} catch (e) {
return { status: 'degraded', redis: 'error' };
}
});

await registerCacheRoutes(app);

await app.listen({ port: config.port, host: config.host });
app.log.info(`L1 KV server listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
// eslint-disable-next-line no-console
console.error(err);
process.exit(1);
});