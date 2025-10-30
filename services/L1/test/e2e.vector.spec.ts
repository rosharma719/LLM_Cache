import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HTTPMethods } from 'fastify/types/utils';
import { getRedis } from '../src/redis/client';

type ServerModule = typeof import('../src/server');
type AppInstance = Awaited<ReturnType<ServerModule['buildApp']>>;

const vectorDim = 4;

function embedText(text: string): Float32Array {
  const buf = Buffer.from(text, 'utf8');
  const sums = [0, 0, 0];
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    sums[0] += byte;
    sums[1] += byte * (i + 1);
    sums[2] += (byte ^ (i * 131)) & 0xff;
  }
  const base = Math.max(buf.length, 1);
  const v = new Float32Array(vectorDim);
  v[0] = base;
  v[1] = sums[0] / base;
  v[2] = sums[1] / base;
  v[3] = sums[2] / base;
  return v;
}

vi.mock('../src/embeddings', () => ({
  getEmbeddingProvider: () => ({
    dim: vectorDim,
    embed: async (texts: string[]) => texts.map((text) => embedText(text)),
  }),
}));

type InjectOptions = {
  method: HTTPMethods;
  url: string;
  payload?: unknown;
};

type InjectResponse = {
  statusCode: number;
  json(): any;
};

describe('L1 cache + vector search e2e', () => {
  let app: AppInstance;
  const redis = getRedis();
  let skipSuite = false;

  beforeAll(async () => {
    redis.on('error', (err) => {
      if (skipSuite) return;
      console.warn('[redis:error]', err);
    });

    try {
      await Promise.race([
        redis.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('redis_ping_timeout')), 2000)),
      ]);
    } catch (err) {
      skipSuite = true;
      console.warn('[e2e] Skipping vector e2e tests:', (err as Error).message);
      redis.disconnect();
      return;
    }

    try {
      await redis.call('FT._LIST');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unknown command') || message.includes('ERR unknown command')) {
        skipSuite = true;
        console.warn('[e2e] Skipping vector e2e tests: RediSearch module not available (needs Redis Stack).');
        redis.disconnect();
        return;
      }
      throw err;
    }

    try {
      await redis.call('FT.DROPINDEX', 'idx:l1:chunks', 'DD');
    } catch {
      // ignore missing index or RediSearch not installed
    }

    await redis.flushall();

    const { buildApp } = await import('../src/server');
    app = await buildApp();
  });

  afterAll(async () => {
    if (!skipSuite && app) {
      await app.close();
    }
    if (skipSuite) {
      redis.disconnect();
    } else {
      await redis.quit();
    }
    vi.restoreAllMocks();
  });

  async function injectWithTiming(label: string, opts: InjectOptions): Promise<InjectResponse> {
    const start = performance.now();
    const res = (await app.inject(opts as any)) as unknown as InjectResponse;
    const ms = performance.now() - start;
    console.log(`[timings] ${label}: ${ms.toFixed(3)}ms`);
    return res;
  }

  it('writes, vectorizes, and finds content via /search.vector', async () => {
    if (skipSuite) {
      console.warn('[e2e] Redis not available, skipping assertions.');
      return;
    }

    const writePayload = {
      ns: 'e2e',
      text: 'alpha beta gamma delta',
      meta: { source: 'test-suite', chunk: 0 },
      ttl_s: 300,
    };

    const writeRes = await injectWithTiming('POST /cache.write (e2e setup)', {
      method: 'POST',
      url: '/cache.write',
      payload: writePayload,
    });

    expect(writeRes.statusCode).toBe(200);
    const writeBody = writeRes.json() as { item_id: string; vectorized: boolean; vector_error?: string };
    expect(writeBody.item_id).toMatch(/^e2e:/);
    expect(writeBody.vectorized).toBe(true);
    expect(writeBody.vector_error).toBeUndefined();

    const itemId = writeBody.item_id;

    const readRes = await injectWithTiming('GET /cache.get (verify write)', {
      method: 'GET',
      url: `/cache.get?ns=e2e&item_id=${encodeURIComponent(itemId)}`,
    });
    expect(readRes.statusCode).toBe(200);
    const readBody = readRes.json() as any;
    expect(readBody.text).toBe(writePayload.text);
    expect(readBody.meta).toEqual(writePayload.meta);
    expect(readBody.version).toBe(1);
    expect(readBody.vectorized).toBeUndefined();

    const searchRes = await injectWithTiming('POST /search.vector (primary match)', {
      method: 'POST',
      url: '/search.vector',
      payload: {
        ns: 'e2e',
        query: writePayload.text,
        top_k: 4,
      },
    });
    const searchBody = searchRes.json() as {
      results?: Array<{ chunk_id: string; item_id: string; text: string; score: number }>;
      error?: string;
    };
    if (searchRes.statusCode !== 200) {
      console.error('[e2e] search failure', searchBody);
    }
    expect(searchRes.statusCode).toBe(200);
    expect(Array.isArray(searchBody.results)).toBe(true);
    const results = searchBody.results as Array<{ chunk_id: string; item_id: string; text: string; score: number }>;
    expect(results.length).toBeGreaterThan(0);
    const topHit = results[0];
    expect(topHit.item_id).toBe(itemId);
    expect(topHit.text).toBe(writePayload.text);
    expect(Number.isFinite(topHit.score)).toBe(true);

    const otherNsRes = await injectWithTiming('POST /search.vector (different ns)', {
      method: 'POST',
      url: '/search.vector',
      payload: {
        ns: 'other',
        query: writePayload.text,
        top_k: 4,
      },
    });
    expect(otherNsRes.statusCode).toBe(200);
    const otherBody = otherNsRes.json() as { results: unknown[] };
    expect(Array.isArray(otherBody.results)).toBe(true);
    expect(otherBody.results.length).toBe(0);
  });
});
