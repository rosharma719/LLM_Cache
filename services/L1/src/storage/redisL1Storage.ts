import { getRedis } from '../redis/client';
import { chunkIndex, ensureChunkVectorIndex } from '../redis/schema';
import { upsertChunks } from '../redis/chunk';
import { deleteItem, getItem, getTTL, listItemIds, setTTL, upsertItem } from '../redis/kv';
import { getEmbeddingProvider } from '../embeddings';
import type {
  CacheEntry,
  CacheWriteResult,
  L1StorageBackend,
  CacheWritePayload,
  ChunkPayload,
  VectorSearchInput,
  VectorSearchResult,
} from '../contracts/l1Storage';
import type { ItemRecord, ItemId, Namespace } from '../types';

/**
 * Implements `L1StorageBackend` on top of the existing Redis helpers.
 * Routes can now consume this backend rather than calling Redis directly.
 */
export class RedisL1StorageBackend implements L1StorageBackend {
  async write(payload: CacheWritePayload, chunks: ChunkPayload[]): Promise<CacheWriteResult> {
    const { meta_json, ttl_s, ns, item_id } = payload;
    if (!ns) {
      throw new Error('namespace required');
    }
    const itemId = await upsertItem(payload);

    if (chunks.length === 0) {
      return { itemId, vectorized: false };
    }

    const chunkPayloads = chunks.map((chunk) => ({
      seq: chunk.seq,
      text: chunk.text,
      meta_json,
    }));
    const hasAllVectors = chunks.every((chunk) => typeof chunk.vector !== 'undefined');
    if (!hasAllVectors) {
      return { itemId, vectorized: false };
    }

    const vectors = chunks.map((chunk) => chunk.vector as Float32Array) as Float32Array[];
    try {
      await upsertChunks(ns, itemId, chunkPayloads, vectors, Date.now(), ttl_s);
      return { itemId, vectorized: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        itemId,
        vectorized: false,
        vectorError: 'vector_store_failed',
        vectorErrorDetail: detail,
      };
    }
  }

  async read(namespace: Namespace, itemId: ItemId) {
    const entry = await getItem(namespace, itemId);
    if (!entry) return null;
    return this.normalizeEntry(entry);
  }

  async delete(namespace: Namespace, itemId: ItemId) {
    return deleteItem(namespace, itemId);
  }

  async list(namespace: Namespace, count?: number) {
    return listItemIds(namespace, count);
  }

  async setTTL(itemId: ItemId, ttlSeconds: number) {
    return setTTL(itemId, ttlSeconds);
  }

  async getTTL(itemId: ItemId) {
    return getTTL(itemId);
  }

  async vectorSearch(input: VectorSearchInput) {
    const { namespace, query, topK = 8 } = input;
    const provider = getEmbeddingProvider();
    const [qvec] = await provider.embed([query]);
    if (!qvec) {
      throw new Error('embedding_failed');
    }

    await ensureChunkVectorIndex(provider);

    const qbuf = Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength);
    const redis = getRedis();
    const queryString = `(@ns:{${this.escapeTag(namespace)}})=>[KNN ${topK} @${chunkIndex.vectorField} $blob_vec AS score]`;
    const res = await redis.call(
      'FT.SEARCH',
      chunkIndex.name,
      queryString,
      'PARAMS',
      '2',
      'blob_vec',
      qbuf,
      'SORTBY',
      'score',
      'ASC',
      'RETURN',
      '5',
      'chunk_id',
      'item_id',
      'text',
      'score',
      'meta_json',
      'DIALECT',
      '3',
      'LIMIT',
      '0',
      String(topK),
    );

    return this.normalizeFtResults(res, namespace);
  }

  private normalizeEntry(entry: ItemRecord): CacheEntry {
    const normalized: CacheEntry = { ...entry };
    if (entry.meta_json) {
      try {
        normalized.meta = JSON.parse(entry.meta_json);
      } catch {
        normalized.meta = undefined;
      }
    }
    return normalized;
  }

  private normalizeFtResults(ftRes: any, namespace: Namespace): VectorSearchResult[] {
    if (!Array.isArray(ftRes) || ftRes.length < 2) return [];

    const results: VectorSearchResult[] = [];
    for (let i = 1; i < ftRes.length; i += 2) {
      const key = this.toStringSafe(ftRes[i]);
      const fields = ftRes[i + 1];
      if (!Array.isArray(fields)) continue;

      const doc: Record<string, string> = {};
      for (let j = 0; j < fields.length; j += 2) {
        const field = this.toStringSafe(fields[j]);
        const value = this.toStringSafe(fields[j + 1]);
        doc[field] = value;
      }

      const chunkId = doc.chunk_id || this.stripPrefix(key);
      const itemId = doc.item_id ?? '';
      if (!chunkId || !itemId) continue;

      let score = Number(doc.score);
      if (!Number.isFinite(score)) score = Number.POSITIVE_INFINITY;

      const result: VectorSearchResult = {
        chunkId,
        itemId,
        namespace,
        text: doc.text ?? '',
        score,
      };

      if (doc.meta_json) {
        try {
          result.meta = JSON.parse(doc.meta_json);
        } catch {
          //
        }
      }

      results.push(result);
    }

    return results;
  }

  private stripPrefix(chunkKey: string) {
    return chunkKey.startsWith(chunkIndex.prefix) ? chunkKey.slice(chunkIndex.prefix.length) : chunkKey;
  }

  private toStringSafe(value: unknown) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value == null) return '';
    return String(value);
  }

  private escapeTag(tag: string) {
    return tag.replace(/([,{}|\\])/g, '\\$1');
  }
}

export const redisL1StorageBackend = new RedisL1StorageBackend();
