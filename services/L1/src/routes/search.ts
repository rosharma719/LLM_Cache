// src/routes/search.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRedis } from '../redis/client';
import { getEmbeddingProvider } from '../embeddings';

export async function registerSearchRoutes(app: FastifyInstance) {
  app.post('/search.vector', async (req, reply) => {
    const parsed = z.object({
      ns: z.string().min(1),
      query: z.string().min(1),
      top_k: z.number().int().positive().max(200).optional()
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { ns, query, top_k = 8 } = parsed.data;

    const provider = getEmbeddingProvider();
    const [qvec] = await provider.embed([query]);
    const qbuf = Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength);

    // RediSearch KNN query (COSINE)
    // Note: dialect 3, use PARAMS for vector
    // FILTER by @ns
    const r = getRedis();
    const q = `(@ns:{${ns}})=>[KNN ${top_k} @vec $BLOB AS score]`;
    const args = [
      'idx:l1:chunks', q,
      'PARAMS', '2', 'BLOB', qbuf,
      'SORTBY', 'score', 'ASC',
      'RETURN', '4', 'chunk_id', 'item_id', 'text', 'score',
      'DIALECT', '3'
    ];

    // @ts-ignore ioredis types don’t know ft.search signature
    const res = await (r as any).ft_search(...args);

    // Format result depending on your client’s return structure
    return reply.send({ results: normalizeFtResults(res) });
  });
}

function normalizeFtResults(ftRes: any): Array<{chunk_id: string; item_id: string; text: string; score: number}> {
  // implement minimal adapter for your client (ioredis vs redis)
  // For brevity, assume ft.search returns array of docs with fields
  // Return: [{chunk_id, item_id, text, score}, ...]
  return Array.isArray(ftRes?.documents)
    ? ftRes.documents.map((d: any) => ({
        chunk_id: d.value.chunk_id,
        item_id: d.value.item_id,
        text: d.value.text,
        score: Number(d.value.score)
      }))
    : [];
}
