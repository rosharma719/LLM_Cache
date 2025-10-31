import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { wrapWithCacheDedup } from '../src/sdk/wrapWithCacheDedup';

describe('wrapWithCacheDedup', () => {
  it('caches the first call and reuses the cached value on subsequent invocations', async () => {
    const store = new Map<string, CachedEntry>(); // id -> entry
    const queryToId = new Map<string, string>();
    let searchCount = 0;
    let writeCount = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/search.vector')) {
        searchCount += 1;
        const body = parseBody(init?.body);
        const id = queryToId.get(body.query);

        if (!id) {
          return jsonResponse({ results: [] });
        }

        const hit = store.get(id);
        if (!hit) {
          return jsonResponse({ results: [] });
        }

        return jsonResponse({
          results: [
            {
              chunk_id: `chunk-${hit.id}`,
              item_id: hit.id,
              text: hit.query,
              score: 0.01,
            },
          ],
        });
      }

      if (url.includes('/cache.get')) {
        const parsed = new URL(url);
        const itemId = parsed.searchParams.get('item_id') ?? '';
        const entry = store.get(itemId);
        if (!entry) {
          return new Response('', { status: 404 });
        }
        return jsonResponse({
          item_id: entry.id,
          ns: 'demo',
          text: entry.query,
          meta: { response: entry.response },
        });
      }

      if (url.endsWith('/cache.write')) {
        writeCount += 1;
        const body = parseBody(init?.body);
        const id = body.item_id as string;
        const entry: CachedEntry = {
          id,
          query: body.text,
          response: body.meta?.response,
        };
        store.set(entry.id, entry);
        queryToId.set(entry.query, entry.id);
        return jsonResponse({ item_id: id, vectorized: true });
      }

      throw new Error(`Unexpected fetch call for URL: ${url}`);
    };

    let originalCalls = 0;
    async function addOne(x: number): Promise<number> {
      originalCalls += 1;
      return x + 1;
    }

    const wrapped = wrapWithCacheDedup<[number], number>(
      {
        ns: 'demo',
        baseUrl: 'http://l1.test',
        fetch: mockFetch,
        maxDistance: 0.1,
      },
      addOne,
    );

    const first = await wrapped(5);
    expect(first).toBe(6);
    expect(originalCalls).toBe(1);
    expect(writeCount).toBe(1);
    expect(searchCount).toBe(1);
    expect(store.has(makeId('demo', [5]))).toBe(true);

    const second = await wrapped(5);
    expect(second).toBe(6);
    expect(originalCalls).toBe(1);
    expect(writeCount).toBe(1);
    expect(searchCount).toBe(1); // direct cache hit avoided vector lookup
  });
});

describe('wrapWithCacheDedup distance threshold', () => {
  it('falls back to original function when score exceeds maxDistance', async () => {
    const store = new Map<string, CachedEntry>();
    const queryToId = new Map<string, string>();
    let searchCount = 0;
    let writeCount = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/search.vector')) {
        searchCount += 1;
        const body = parseBody(init?.body);
        const id = queryToId.get(body.query);
        const hit = id ? store.get(id) : undefined;
        if (!hit) return jsonResponse({ results: [] });
        return jsonResponse({
          results: [
            {
              chunk_id: `chunk-${hit.id}`,
              item_id: hit.id,
              text: hit.query,
              score: 0.91, // above cutoff
            },
          ],
        });
      }

      if (url.includes('/cache.get')) {
        const parsed = new URL(url);
        const itemId = parsed.searchParams.get('item_id') ?? '';
        const entry = store.get(itemId);
        if (!entry) return new Response('', { status: 404 });
        return jsonResponse({
          item_id: entry.id,
          ns: 'demo',
          text: entry.query,
          meta: { response: entry.response },
        });
      }

      if (url.endsWith('/cache.write')) {
        writeCount += 1;
        const body = parseBody(init?.body);
        const id = body.item_id as string;
        const entry: CachedEntry = {
          id,
          query: body.text,
          response: body.meta?.response,
        };
        store.set(entry.id, entry);
        queryToId.set(entry.query, entry.id);
        return jsonResponse({ item_id: id, vectorized: true });
      }

      throw new Error(`Unexpected fetch call for URL: ${url}`);
    };

    let originalCalls = 0;
    async function addOne(x: number): Promise<number> {
      originalCalls += 1;
      return x + 1;
    }

    const wrapped = wrapWithCacheDedup<[number], number>(
      {
        ns: 'demo',
        baseUrl: 'http://l1.test',
        fetch: mockFetch,
        maxDistance: 0.5,
      },
      addOne,
    );

    const first = await wrapped(1);
    expect(first).toBe(2);
    expect(originalCalls).toBe(1);

    const second = await wrapped(2);
    expect(second).toBe(3);
    expect(originalCalls).toBe(2); // exceeded distance, so recomputed
    expect(writeCount).toBe(2);
    expect(searchCount).toBe(2);
  });
});

type CachedEntry = {
  id: string;
  query: string;
  response: unknown;
};

function parseBody(body: BodyInit | null | undefined): any {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof ArrayBuffer) return JSON.parse(Buffer.from(body).toString('utf8'));
  if (ArrayBuffer.isView(body)) return JSON.parse(Buffer.from(body.buffer).toString('utf8'));
  if (typeof body === 'object' && 'text' in (body as any)) {
    const reqBody = (body as any).text();
    throw new Error(`Unsupported body type in mock: ${reqBody}`);
  }
  throw new Error('Unsupported mock body type');
}

function makeId(ns: string, args: unknown[]): string {
  const digest = createHash('sha1').update(JSON.stringify(args)).digest('hex');
  return `dedup:${ns}:${digest}`;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
