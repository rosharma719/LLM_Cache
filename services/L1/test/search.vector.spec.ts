import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HTTPMethods } from 'fastify/types/utils';

const ensureChunkVectorIndexMock = vi.fn();
const redisCallMock = vi.fn();
const embedMock = vi.fn();

vi.mock('../src/redis/schema', () => ({
  ensureChunkVectorIndex: ensureChunkVectorIndexMock,
  chunkIndex: { name: 'idx:l1:chunks', vectorField: 'vec', prefix: 'l1:chunk:' },
}));

vi.mock('../src/embeddings', () => ({
  getEmbeddingProvider: () => ({
    dim: 3,
    embed: embedMock,
  }),
}));

vi.mock('../src/redis/client', () => ({
  getRedis: () => ({
    call: redisCallMock,
  }),
}));

type ServerModule = typeof import('../src/server');
type AppInstance = Awaited<ReturnType<ServerModule['buildApp']>>;

describe('/search.vector', () => {
  let app: AppInstance;

  type MinimalInjectOptions = {
    method: HTTPMethods;
    url: string;
    payload?: unknown;
  };

  type MinimalInjectResponse = {
    statusCode: number;
    json(): any;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ensureChunkVectorIndexMock.mockResolvedValue(undefined);
    const vector = new Float32Array([0.1, 0.2, 0.3]);
    embedMock.mockResolvedValue([vector]);
    redisCallMock.mockResolvedValue([
      1,
      'l1:chunk:item123#0',
      [
        'chunk_id',
        'item123#0',
        'item_id',
        'item123#0',
        'text',
        'example chunk text',
        'score',
        '0.1234',
      ],
    ]);

    const { buildApp } = await import('../src/server');
    app = await buildApp();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  async function injectWithTiming(
    label: string,
    opts: MinimalInjectOptions,
  ): Promise<MinimalInjectResponse> {
    const start = performance.now();
    const res = (await app.inject(opts as any)) as unknown as MinimalInjectResponse;
    const ms = performance.now() - start;
    console.log(`[timings] ${label}: ${ms.toFixed(3)}ms`);
    return res;
  }

  it('ensures index, runs vector search, and normalizes response', async () => {
    const res = await injectWithTiming('POST /search.vector (success)', {
      method: 'POST',
      url: '/search.vector',
      payload: {
        ns: 'namespace',
        query: 'hello world',
        top_k: 5,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(ensureChunkVectorIndexMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(['hello world']);
    expect(redisCallMock).toHaveBeenCalledTimes(1);

    const callArgs = redisCallMock.mock.calls[0];
    expect(callArgs[0]).toBe('FT.SEARCH');
    expect(callArgs[1]).toBe('idx:l1:chunks');
    expect(callArgs[2]).toContain('@ns:{namespace}');
    const bufferArgIndex = callArgs.findIndex((arg) => Buffer.isBuffer(arg));
    expect(bufferArgIndex).toBeGreaterThan(-1);

    const body = res.json() as any;
    expect(body.results).toEqual([
      {
        chunk_id: 'item123#0',
        item_id: 'item123#0',
        text: 'example chunk text',
        score: 0.1234,
      },
    ]);
  });

  it('reports vector_search_failed when redis call throws', async () => {
    const error = new Error('boom');
    redisCallMock.mockRejectedValueOnce(error);

    const res = await injectWithTiming('POST /search.vector (error path)', {
      method: 'POST',
      url: '/search.vector',
      payload: { ns: 'namespace', query: 'hello' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'vector_search_failed', detail: 'boom' });
  });
});
