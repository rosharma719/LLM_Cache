/**
 * Demo wrapper around OpenAI chat completions with L1 vector cache integration.
 *
 * Flow:
 *  1. Embed the incoming prompt via the L1 `/search.vector` endpoint.
 *  2. If a close-enough match is found, return the cached response immediately.
 *  3. Otherwise call OpenAI, persist the query/response via `/cache.write`, and return the fresh answer.
 */
import { createHash } from 'crypto';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = 'http://localhost:8080';
const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MAX_DISTANCE = 0.5;

export interface CachedChatOptions {
  /**
   * Namespace to scope all cache entries (maps to the `ns` field in the API).
   */
  namespace: string;
  /**
   * Location of the L1 service.
   */
  baseUrl?: string;
  /**
   * OpenAI API key used for uncached calls.
   */
  openAIApiKey: string;
  /**
   * Chat completion model name. Defaults to `gpt-4o-mini`.
   */
  model?: string;
  /**
   * Temperature for chat completions. Defaults to 0.2.
   */
  temperature?: number;
  /**
   * Optional system prompt to prepend when calling OpenAI.
   */
  systemPrompt?: string;
  /**
   * Maximum number of neighbors we pull back from the vector search. Defaults to 3.
   */
  topK?: number;
  /**
   * Optional distance threshold. If supplied, cached hits with a score above this value are ignored.
   * (Lower is closer; the value depends on the distance metric configured in the RediSearch index.)
   */
  maxDistance?: number;
  /**
   * Optional TTL for newly cached entries (in seconds).
   */
  ttlSeconds?: number;
  /**
   * Allows dependency injection for testing.
   */
  fetch?: FetchLike;
}

export type CachedChatResultSource = 'cache' | 'openai';

export interface CachedChatResult {
  response: string;
  source: CachedChatResultSource;
  /**
   * Returned when we hit the cache (existing id) or after we persist a new answer.
   */
  itemId?: string;
  /**
   * Vector distance for cached hits (smaller == better). Undefined when we missed.
   */
  score?: number;
  /**
   * When the cached payload was written. Populated if present in the stored metadata.
   */
  cachedAt?: string;
}

interface SearchVectorHit {
  chunk_id: string;
  item_id: string;
  text: string;
  score: number;
}

interface SearchVectorResponse {
  results: SearchVectorHit[];
}

interface CacheWriteResponse {
  item_id: string;
  vectorized: boolean;
  vector_error?: string;
}

interface CacheGetResponse {
  item_id: string;
  ns: string;
  text: string;
  meta?: unknown;
}

interface StoredMeta {
  response: string;
  provider?: string;
  model?: string;
  cached_at?: string;
  [key: string]: unknown;
}

export class CachedChatbot {
  private readonly namespace: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly systemPrompt?: string;
  private readonly topK: number;
  private readonly maxDistance?: number;
  private readonly ttlSeconds?: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: CachedChatOptions) {
    if (!options.namespace.trim()) throw new Error('namespace is required');
    if (!options.openAIApiKey.trim()) throw new Error('openAIApiKey is required');

    this.namespace = options.namespace;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.openAIApiKey;
    this.model = options.model ?? 'gpt-4o-mini';
    this.temperature = options.temperature ?? 0.2;
    this.systemPrompt = options.systemPrompt;
    this.topK = options.topK ?? 3;
    this.maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
    this.ttlSeconds = options.ttlSeconds;

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required (provide options.fetch when running on Node <18).');
    }
    this.fetchImpl = fetchImpl.bind ? fetchImpl.bind(globalThis) : fetchImpl;
  }

  /**
   * Main entry-point used by demo/chat UI code.
   */
  async ask(prompt: string): Promise<CachedChatResult> {
    if (!prompt.trim()) throw new Error('prompt must be a non-empty string');

    const cached = await this.lookupCachedResponse(prompt);
    if (cached) {
      return {
        response: cached.response,
        source: 'cache',
        itemId: cached.itemId,
        score: cached.score,
        cachedAt: cached.cachedAt,
      };
    }

    const response = await this.callOpenAI(prompt);
    const itemId = await this.persist(prompt, response);
    return { response, source: 'openai', itemId };
  }

  private async lookupCachedResponse(prompt: string): Promise<{ response: string; itemId: string; score?: number; cachedAt?: string } | null> {
    const cacheId = this.makeCacheId(prompt);

    const direct = await this.fetchCacheRecord(cacheId);
    const directMeta = direct ? coerceMeta(direct.meta) : null;
    if (direct && directMeta?.response) {
      return {
        response: directMeta.response,
        itemId: direct.item_id,
        cachedAt: directMeta.cached_at,
      };
    }

    const res = await this.fetchImpl(`${this.baseUrl}/search.vector`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ns: this.namespace,
        query: prompt,
        top_k: this.topK,
      }),
    });

    if (!res.ok) {
      const detail = await safeReadBody(res);
      throw new Error(`Vector search failed: ${res.status} ${res.statusText}${detail}`);
    }

    const payload = (await res.json()) as SearchVectorResponse;
    if (!payload.results || payload.results.length === 0) return null;

    const best = payload.results[0];
    if (!best?.item_id) return null;
    if (this.maxDistance !== undefined && typeof best.score === 'number' && best.score > this.maxDistance) {
      return null;
    }

    const item = await this.fetchCacheRecord(best.item_id);
    if (!item) return null;

    const meta = coerceMeta(item.meta);
    if (!meta?.response) return null;

    return {
      response: meta.response,
      itemId: item.item_id,
      score: best.score,
      cachedAt: meta.cached_at,
    };
  }

  private async fetchCacheRecord(itemId: string): Promise<CacheGetResponse | null> {
    const qs = new URLSearchParams({ ns: this.namespace, item_id: itemId });
    const res = await this.fetchImpl(`${this.baseUrl}/cache.get?${qs.toString()}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await safeReadBody(res);
      throw new Error(`cache.get failed: ${res.status} ${res.statusText}${detail}`);
    }
    return (await res.json()) as CacheGetResponse;
  }

  private async callOpenAI(prompt: string): Promise<string> {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const res = await this.fetchImpl(OPENAI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        messages,
      }),
    });

    if (!res.ok) {
      const detail = await safeReadBody(res);
      throw new Error(`OpenAI chat call failed: ${res.status} ${res.statusText}${detail}`);
    }

    const payload = (await res.json()) as OpenAIChatResponse;
    const message = payload.choices?.[0]?.message?.content?.trim();
    if (!message) {
      throw new Error('OpenAI chat response missing content');
    }
    return message;
  }

  private async persist(prompt: string, response: string): Promise<string> {
    const cacheId = this.makeCacheId(prompt);
    const res = await this.fetchImpl(`${this.baseUrl}/cache.write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ns: this.namespace,
        item_id: cacheId,
        text: prompt,
        ttl_s: this.ttlSeconds,
        meta: {
          response,
          provider: 'openai',
          model: this.model,
          cached_at: new Date().toISOString(),
          query: prompt,
        } satisfies StoredMeta,
      }),
    });

    if (!res.ok) {
      const detail = await safeReadBody(res);
      throw new Error(`cache.write failed: ${res.status} ${res.statusText}${detail}`);
    }

    const payload = (await res.json()) as CacheWriteResponse;
    if (payload.vector_error) {
      console.warn('CachedChatbot.persist: vectorization error', payload.vector_error);
    }
    return payload.item_id ?? cacheId;
  }

  private makeCacheId(prompt: string): string {
    const digest = createHash('sha1').update(prompt).digest('hex');
    return `dedup:${this.namespace}:${digest}`;
  }
}

interface OpenAIChatResponse {
  id: string;
  choices?: Array<{
    index: number;
    message?: {
      role: string;
      content?: string | null;
    };
    finish_reason?: string;
  }>;
}

function coerceMeta(meta: unknown): StoredMeta | null {
  if (!meta || typeof meta !== 'object') return null;
  if ('response' in meta && typeof (meta as StoredMeta).response === 'string') {
    return meta as StoredMeta;
  }
  return null;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` - ${text}` : '';
  } catch {
    return '';
  }
}
