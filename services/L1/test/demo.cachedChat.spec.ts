import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { CachedChatbot } from '../src/demo/cachedChat';

describe('CachedChatbot', () => {
  it('falls back to OpenAI on a miss and reuses cached responses afterwards', async () => {
    const store = new Map<string, StoredItem>(); // id -> record
    const queryToId = new Map<string, string>();
    let openAICallCount = 0;

    const mockFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/search.vector')) {
        const body = parseBody(init?.body);
        const key = body.query as string;
        const id = key ? queryToId.get(key) ?? [...store.values()][0]?.id : undefined;
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
              score: 0.012,
            },
          ],
        });
      }

      if (url.includes('/cache.get')) {
        const parsed = new URL(url);
        const itemId = parsed.searchParams.get('item_id') ?? '';
        const item = store.get(itemId);
        if (!item) {
          return new Response('', { status: 404 });
        }
        return jsonResponse({
          item_id: item.id,
          ns: 'demo',
          text: item.query,
          meta: {
            response: item.response,
            cached_at: item.cachedAt,
          },
        });
      }

      if (url.endsWith('/cache.write')) {
        const body = parseBody(init?.body);
        const id = body.item_id as string;
        const cachedAt = body.meta?.cached_at ?? new Date().toISOString();
        const record: StoredItem = {
          id,
          query: body.text,
          response: body.meta?.response ?? '',
          cachedAt,
        };
        store.set(id, record);
        queryToId.set(record.query, id);
        return jsonResponse({ item_id: id, vectorized: true });
      }

      if (url === 'https://api.openai.com/v1/chat/completions') {
        openAICallCount += 1;
        return jsonResponse({
          id: `chat-${openAICallCount}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `fresh response #${openAICallCount}`,
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch mock for URL: ${url}`);
    };

    const chatbot = new CachedChatbot({
      namespace: 'demo',
      baseUrl: 'http://l1.test',
      openAIApiKey: 'test-key',
      fetch: mockFetch,
      maxDistance: 0.2,
    });

    const first = await chatbot.ask('What is vector search?');
    expect(first.source).toBe('openai');
    expect(first.response).toBe('fresh response #1');
    expect(first.itemId).toBe(makeId('demo', 'What is vector search?'));
    expect(openAICallCount).toBe(1);

    const second = await chatbot.ask('What is vector search?');
    expect(second.source).toBe('cache');
    expect(second.response).toBe('fresh response #1');
    expect(second.itemId).toBe(first.itemId);
    expect(second.score).toBeUndefined();
    expect(openAICallCount).toBe(1);
  });
});

describe('CachedChatbot distance threshold', () => {
  it('ignores cached hits when score exceeds maxDistance', async () => {
    const store = new Map<string, StoredItem>();
    const queryToId = new Map<string, string>();
    let openAICallCount = 0;

    const mockFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/search.vector')) {
        const body = parseBody(init?.body);
        const key = body.query as string;
        const id = key ? queryToId.get(key) ?? [...store.values()][0]?.id : undefined;
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
              score: 0.9, // above cutoff
            },
          ],
        });
      }

      if (url.includes('/cache.get')) {
        const parsed = new URL(url);
        const itemId = parsed.searchParams.get('item_id') ?? '';
        const item = store.get(itemId);
        if (!item) return new Response('', { status: 404 });
        return jsonResponse({
          item_id: item.id,
          ns: 'demo',
          text: item.query,
          meta: { response: item.response },
        });
      }

      if (url.endsWith('/cache.write')) {
        const body = parseBody(init?.body);
        const id = body.item_id as string;
        const record: StoredItem = {
          id,
          query: body.text,
          response: body.meta?.response ?? '',
          cachedAt: new Date().toISOString(),
        };
        store.set(id, record);
        queryToId.set(record.query, id);
        return jsonResponse({ item_id: id, vectorized: true });
      }

      if (url === 'https://api.openai.com/v1/chat/completions') {
        openAICallCount += 1;
        return jsonResponse({
          id: `chat-${openAICallCount}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `fresh response #${openAICallCount}`,
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch mock for URL: ${url}`);
    };

    const chatbot = new CachedChatbot({
      namespace: 'demo',
      baseUrl: 'http://l1.test',
      openAIApiKey: 'test-key',
      fetch: mockFetch,
      maxDistance: 0.5,
    });

    const first = await chatbot.ask('Explain L1 cache');
    expect(first.source).toBe('openai');
    expect(openAICallCount).toBe(1);

    const second = await chatbot.ask('Explain L1 cache in detail');
    expect(second.source).toBe('openai'); // high score treated as miss
    expect(openAICallCount).toBe(2);
  });
});

type StoredItem = {
  id: string;
  query: string;
  response: string;
  cachedAt: string;
};

function parseBody(body: BodyInit | null | undefined): any {
  if (!body) return {};
  if (typeof body === 'string') {
    return JSON.parse(body);
  }
  if (body instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(body).toString('utf8'));
  }
  if (ArrayBuffer.isView(body)) {
    return JSON.parse(Buffer.from(body.buffer).toString('utf8'));
  }
  throw new Error('Unsupported mock body type');
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeId(ns: string, query: string): string {
  const digest = createHash('sha1').update(query).digest('hex');
  return `dedup:${ns}:${digest}`;
}
