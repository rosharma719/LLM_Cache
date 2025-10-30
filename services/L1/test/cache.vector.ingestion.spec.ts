import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upsertItemMock = vi.fn();
const upsertChunksMock = vi.fn();
const chunkTextMock = vi.fn();
const embedMock = vi.fn();
const getEmbeddingProviderMock = vi.fn();

type TimingMap = Record<string, number>;
const timings: TimingMap = {};

function recordTiming<T extends (...args: any[]) => any>(key: string, impl: T): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    const start = performance.now();
    try {
      const result = impl(...args);
      if (result && typeof (result as any).then === 'function') {
        return (result as Promise<any>)
          .finally(() => {
            timings[key] = performance.now() - start;
          }) as ReturnType<T>;
      }
      timings[key] = performance.now() - start;
      return result;
    } catch (err) {
      timings[key] = performance.now() - start;
      throw err;
    }
  }) as T;
}

vi.mock('../src/redis/kv', () => ({
  upsertItem: upsertItemMock,
  getItem: vi.fn(),
  deleteItem: vi.fn(),
  listItemIds: vi.fn(),
  getTTL: vi.fn(),
  setTTL: vi.fn(),
}));

vi.mock('../src/redis/chunk', () => ({
  upsertChunks: upsertChunksMock,
}));

vi.mock('../src/chunking/simple', () => ({
  chunkText: chunkTextMock,
}));

vi.mock('../src/embeddings', () => ({
  getEmbeddingProvider: getEmbeddingProviderMock,
}));

describe('/cache.write vector ingestion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    timings.embed = timings.upsertItem = timings.upsertChunks = timings.chunkText = 0;

    chunkTextMock.mockImplementation(
      recordTiming('chunkText', (text: string, size?: number, overlap?: number) => []),
    );

    upsertItemMock.mockImplementation(
      recordTiming('upsertItem', async () => 'test:generated'),
    );
    upsertChunksMock.mockImplementation(
      recordTiming('upsertChunks', async () => undefined),
    );
    embedMock.mockImplementation(
      recordTiming('embed', async () => []),
    );

    getEmbeddingProviderMock.mockReturnValue({ dim: 3, embed: embedMock });
  });

  afterEach(() => {
    vi.clearAllMocks();
    timings.embed ??= 0;
    timings.upsertItem ??= 0;
    timings.upsertChunks ??= 0;
    timings.chunkText ??= 0;
  });

  afterEach((ctx) => {
    console.log(`[timings] ${ctx.task.name}`, timings);
  });

  it('chunks text, embeds, and stores vectors when successful', async () => {
    const chunks = [
      { seq: 0, text: 'first chunk' },
      { seq: 1, text: 'second chunk' },
    ];
    chunkTextMock.mockImplementation(
      recordTiming('chunkText', () => chunks),
    );

    const vectors = [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.4, 0.5, 0.6])];
    embedMock.mockImplementation(
      recordTiming('embed', async () => vectors),
    );
    const metaStr = JSON.stringify({ foo: 'bar' });

    const { buildApp } = await import('../src/server');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/cache.write',
        payload: {
          ns: 'ns1',
          text: 'blob of text',
          meta: { foo: 'bar' },
          ttl_s: 120,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as any;
      expect(body.item_id).toBe('test:generated');
      expect(body.vectorized).toBe(true);
      expect(body.vector_error).toBeUndefined();

      expect(chunkTextMock).toHaveBeenCalledWith('blob of text');
      expect(embedMock).toHaveBeenCalledWith(['first chunk', 'second chunk']);
      expect(upsertItemMock).toHaveBeenCalledWith({
        ns: 'ns1',
        item_id: undefined,
        text: 'blob of text',
        meta_json: metaStr,
        ttl_s: 120,
      });

      expect(upsertChunksMock).toHaveBeenCalledTimes(1);
      const [nsArg, itemArg, chunkArg, vectorsArg, timestampArg, ttlArg] = upsertChunksMock.mock.calls[0];
      expect(nsArg).toBe('ns1');
      expect(itemArg).toBe('test:generated');
      expect(chunkArg).toEqual([
        { seq: 0, text: 'first chunk', meta_json: metaStr },
        { seq: 1, text: 'second chunk', meta_json: metaStr },
      ]);
      expect(vectorsArg).toEqual(vectors);
      expect(typeof timestampArg).toBe('number');
      expect(ttlArg).toBe(120);
      expect(upsertChunksMock).toHaveBeenCalledWith(
        'ns1',
        'test:generated',
        [
          { seq: 0, text: 'first chunk', meta_json: metaStr },
          { seq: 1, text: 'second chunk', meta_json: metaStr },
        ],
        vectors,
        expect.any(Number),
        120,
      );
    } finally {
      await app.close();
    }
  });

  it('continues without vectors when embedding fails', async () => {
    chunkTextMock.mockImplementation(
      recordTiming('chunkText', () => [{ seq: 0, text: 'only chunk' }]),
    );
    embedMock.mockImplementation(
      recordTiming('embed', async () => {
        throw new Error('no key');
      }),
    );

    const { buildApp } = await import('../src/server');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/cache.write',
        payload: {
          ns: 'ns-fail',
          text: 'text needing embedding',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as any;
      expect(body.vectorized).toBe(false);
      expect(body.vector_error).toBe('vectorization_failed');

      expect(upsertItemMock).toHaveBeenCalled();
      expect(upsertChunksMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reports storage failure when persisting chunks errors', async () => {
    chunkTextMock.mockImplementation(
      recordTiming('chunkText', () => [{ seq: 0, text: 'chunk' }]),
    );
    embedMock.mockImplementation(
      recordTiming('embed', async () => [new Float32Array([0.1, 0.2, 0.3])]),
    );
    upsertChunksMock.mockImplementation(
      recordTiming('upsertChunks', async () => {
        throw new Error('redis write failed');
      }),
    );

    const { buildApp } = await import('../src/server');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/cache.write',
        payload: {
          ns: 'ns-store-fail',
          text: 'chunking text',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as any;
      expect(body.vectorized).toBe(false);
      expect(body.vector_error).toBe('vector_store_failed');

    } finally {
      await app.close();
    }
  });
});
