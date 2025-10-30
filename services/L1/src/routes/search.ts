// src/routes/search.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRedis } from '../redis/client';
import { getEmbeddingProvider } from '../embeddings';
import { ensureChunkVectorIndex, chunkIndex } from '../redis/schema';

export async function registerSearchRoutes(app: FastifyInstance) {
  app.post('/search.vector', async (req, reply) => {
    const parsed = z.object({
      ns: z.string().min(1),
      query: z.string().min(1),
      top_k: z.number().int().positive().max(200).optional()
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { ns, query, top_k = 8 } = parsed.data;

    try {
      const provider = getEmbeddingProvider();
      await ensureChunkVectorIndex(provider);

      const [qvec] = await provider.embed([query]);
      if (!qvec) {
        return reply.code(500).send({ error: 'embedding_failed' });
      }

      const qbuf = Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength);

      const redis = getRedis();
      const queryString = `(@ns:{${escapeTag(ns)}})=>[KNN ${top_k} @${chunkIndex.vectorField} $blob_vec AS score]`;
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
        '4',
        'chunk_id',
        'item_id',
        'text',
        'score',
        'DIALECT',
        '3',
        'LIMIT',
        '0',
        String(top_k),
      );

      return reply.send({ results: normalizeFtResults(res) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, 'Vector search failed');
      return reply.code(500).send({ error: 'vector_search_failed', detail: message });
    }
  });
}

function normalizeFtResults(ftRes: any): Array<{ chunk_id: string; item_id: string; text: string; score: number }> {
  if (!Array.isArray(ftRes) || ftRes.length < 2) return [];

  const results: Array<{ chunk_id: string; item_id: string; text: string; score: number }> = [];

  for (let i = 1; i < ftRes.length; i += 2) {
    const key = toStringSafe(ftRes[i]);
    const fields = ftRes[i + 1];
    if (!Array.isArray(fields)) continue;

    const doc: Record<string, string> = {};
    for (let j = 0; j < fields.length; j += 2) {
      const field = toStringSafe(fields[j]);
      const value = toStringSafe(fields[j + 1]);
      doc[field] = value;
    }

    const chunk_id = doc.chunk_id || stripPrefix(key);
    const item_id = doc.item_id ?? '';
    const text = doc.text ?? '';
    const score = doc.score ? Number(doc.score) : NaN;

    if (!chunk_id || !item_id) continue;
    results.push({
      chunk_id,
      item_id,
      text,
      score: Number.isFinite(score) ? score : Number.POSITIVE_INFINITY,
    });
  }

  return results;
}

function toStringSafe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value == null) return '';
  return String(value);
}

function stripPrefix(chunkKey: string): string {
  return chunkKey.startsWith(chunkIndex.prefix) ? chunkKey.slice(chunkIndex.prefix.length) : chunkKey;
}

function escapeTag(tag: string): string {
  return tag.replace(/([,{}|\\])/g, '\\$1');
}
