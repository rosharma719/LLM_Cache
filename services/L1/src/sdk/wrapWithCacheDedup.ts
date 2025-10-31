import { createHash } from 'crypto';

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_TOP_K = 1;
const LOOKUP_TIMER = 'dedup.lookup';
const PERSIST_TIMER = 'dedup.persist';

type FetchImpl = typeof fetch;

interface WrapOptions {
  ns: string;
  baseUrl?: string;
  ttlSeconds?: number;
  topK?: number;
  maxDistance?: number;
  fetch?: FetchImpl;
}

interface SearchVectorHit {
  chunk_id: string;
  item_id: string;
  text: string;
  score: number;
}

interface SearchVectorResponse {
  results?: SearchVectorHit[];
}

interface CacheGetResponse<TResult> {
  item_id: string;
  ns: string;
  text: string;
  meta?: {
    response?: TResult;
    [key: string]: unknown;
  };
}

interface CacheWriteResponse {
  item_id?: string;
  vectorized: boolean;
  vector_error?: string;
}

export function wrapWithCacheDedup<TArgs extends any[], TResult>(
  options: WrapOptions,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  if (!options.ns || !options.ns.trim()) {
    throw new Error('wrapWithCacheDedup: ns is required');
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const maxDistance = options.maxDistance;
  const ttlSeconds = options.ttlSeconds;

  const fetchImpl: FetchImpl | undefined = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      'wrapWithCacheDedup: fetch implementation required (pass options.fetch when running on Node <18).',
    );
  }
  const boundFetch: FetchImpl = fetchImpl.bind ? fetchImpl.bind(globalThis) : fetchImpl;

  return async (...args: TArgs): Promise<TResult> => {
    let serializedArgs: string | null = null;
    try {
      serializedArgs = JSON.stringify(args);
    } catch (err) {
      console.warn('wrapWithCacheDedup: failed to serialize args, skipping cache', err);
    }

    if (serializedArgs) {
      console.time(LOOKUP_TIMER);
      try {
        const cacheId = generateCacheId(options.ns, serializedArgs);

        const direct = await fetchCachedResult<TResult>(boundFetch, baseUrl, {
          ns: options.ns,
          itemId: cacheId,
        });
        if (direct !== null && direct !== undefined) {
          return direct;
        }

        const hit = await searchVector(boundFetch, baseUrl, {
          ns: options.ns,
          query: serializedArgs,
          topK,
        });

        if (hit && (maxDistance === undefined || hit.score < maxDistance)) {
          const cached = await fetchCachedResult<TResult>(boundFetch, baseUrl, {
            ns: options.ns,
            itemId: hit.item_id,
          });
          if (cached !== null && cached !== undefined) {
            return cached;
          }
        }
      } catch (err) {
        console.warn('wrapWithCacheDedup: lookup failed, using live function', err);
      } finally {
        console.timeEnd(LOOKUP_TIMER);
      }
    }

    const result = await fn(...args);

    if (!serializedArgs) {
      return result;
    }

    console.time(PERSIST_TIMER);
    try {
      const cacheId = generateCacheId(options.ns, serializedArgs);
      await persistResult(boundFetch, baseUrl, {
        ns: options.ns,
        query: serializedArgs,
        itemId: cacheId,
        ttlSeconds,
        response: result,
      });
    } catch (err) {
      console.warn('wrapWithCacheDedup: persist failed', err);
    } finally {
      console.timeEnd(PERSIST_TIMER);
    }

    return result;
  };
}

async function searchVector(
  fetchFn: FetchImpl,
  baseUrl: string,
  args: { ns: string; query: string; topK: number },
): Promise<SearchVectorHit | null> {
  const payload: Record<string, unknown> = {
    ns: args.ns,
    query: args.query,
    top_k: args.topK,
  };

  const res = await fetchFn(`${baseUrl}/search.vector`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new Error(`search.vector failed: ${res.status} ${res.statusText}${detail}`);
  }

  const body = (await res.json()) as SearchVectorResponse;
  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length === 0) return null;

  // results should already be sorted ascending by score; ensure by reducing.
  return results.reduce((best: SearchVectorHit | null, current) => {
    if (!best) return current;
    return current.score < best.score ? current : best;
  }, null);
}

async function fetchCachedResult<TResult>(
  fetchFn: FetchImpl,
  baseUrl: string,
  args: { ns: string; itemId: string },
): Promise<TResult | null> {
  const search = new URLSearchParams({ ns: args.ns, item_id: args.itemId });
  const res = await fetchFn(`${baseUrl}/cache.get?${search.toString()}`, {
    method: 'GET',
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new Error(`cache.get failed: ${res.status} ${res.statusText}${detail}`);
  }

  const payload = (await res.json()) as CacheGetResponse<TResult>;
  const response = payload.meta?.response;
  return (response as TResult) ?? null;
}

async function persistResult<TResult>(
  fetchFn: FetchImpl,
  baseUrl: string,
  args: { ns: string; query: string; itemId: string; ttlSeconds?: number; response: TResult },
): Promise<void> {
  const payload: Record<string, unknown> = {
    ns: args.ns,
    item_id: args.itemId,
    text: args.query,
    meta: {
      response: args.response,
      query: args.query,
    },
  };

  if (typeof args.ttlSeconds === 'number') {
    payload.ttl_s = args.ttlSeconds;
  }

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    console.warn('wrapWithCacheDedup: failed to serialize payload for cache.write', err);
    return;
  }

  const res = await fetchFn(`${baseUrl}/cache.write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new Error(`cache.write failed: ${res.status} ${res.statusText}${detail}`);
  }

  const data = (await res.json()) as CacheWriteResponse;
  if (data.vector_error) {
    console.warn('wrapWithCacheDedup: vectorization reported error', data.vector_error);
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` - ${text}` : '';
  } catch {
    return '';
  }
}

function generateCacheId(ns: string, query: string): string {
  const digest = createHash('sha1').update(query).digest('hex');
  return `dedup:${ns}:${digest}`;
}
