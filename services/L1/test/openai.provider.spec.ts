import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv() {
  process.env = { ...ORIGINAL_ENV } as NodeJS.ProcessEnv;
}

function restoreFetch() {
  if (ORIGINAL_FETCH) {
    globalThis.fetch = ORIGINAL_FETCH;
  } else {
    delete (globalThis as any).fetch;
  }
}

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreEnv();
    restoreFetch();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    restoreEnv();
    restoreFetch();
  });

  it('calls OpenAI embeddings API and returns vectors', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

    const embeddingA = Array.from({ length: 1536 }, (_, i) => i / 1536);
    const embeddingB = Array.from({ length: 1536 }, (_, i) => (i + 1) / 1536);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: [
          { index: 1, embedding: embeddingB },
          { index: 0, embedding: embeddingA },
        ],
      }),
    } as unknown as Response);

    (globalThis as any).fetch = fetchMock;

    const { OpenAIProvider } = await import('../src/embeddings/openai');
    const provider = new OpenAIProvider();
    const vectors = await provider.embed(['foo', 'bar']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });

    const body = JSON.parse((options as RequestInit & { body: string }).body);
    expect(body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['foo', 'bar'],
    });

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0].length).toBe(1536);
    expect(vectors[0][0]).toBeCloseTo(embeddingA[0], 6);
    expect(vectors[0][1]).toBeCloseTo(embeddingA[1], 6);
    expect(vectors[0][2]).toBeCloseTo(embeddingA[2], 6);
    expect(vectors[1][0]).toBeCloseTo(embeddingB[0], 6);
    expect(vectors[1][1]).toBeCloseTo(embeddingB[1], 6);
    expect(vectors[1][2]).toBeCloseTo(embeddingB[2], 6);
  });

  it('throws when API key is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

    const { OpenAIProvider } = await import('../src/embeddings/openai');
    const provider = new OpenAIProvider();

    await expect(provider.embed(['foo'])).rejects.toThrow('OPENAI_API_KEY is not configured');
  });

  it('propagates API errors with response details', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limit exceeded',
    } as unknown as Response);
    (globalThis as any).fetch = fetchMock;

    const { OpenAIProvider } = await import('../src/embeddings/openai');
    const provider = new OpenAIProvider();

    await expect(provider.embed(['foo'])).rejects.toThrow(/429.*Rate limit exceeded/);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('getEmbeddingProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreEnv();
    restoreFetch();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    restoreEnv();
    restoreFetch();
  });

  it('returns a cached OpenAI provider', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDING_PROVIDER = 'openai';

    const { getEmbeddingProvider } = await import('../src/embeddings/index');
    const first = getEmbeddingProvider();
    const second = getEmbeddingProvider();

    expect(first).toBe(second);
  });

  it('throws for unsupported providers', async () => {
    process.env.EMBEDDING_PROVIDER = 'bogus';

    const { getEmbeddingProvider } = await import('../src/embeddings/index');
    expect(() => getEmbeddingProvider()).toThrow(/Unsupported embedding provider/);
  });
});
