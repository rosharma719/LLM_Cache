// src/routes/search.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { redisL1StorageBackend } from '../storage/redisL1Storage';

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
      const results = await redisL1StorageBackend.vectorSearch({
        namespace: ns,
        query,
        topK: top_k,
      });

      return reply.send({
        results: results.map((hit) => ({
          chunk_id: hit.chunkId,
          item_id: hit.itemId,
          text: hit.text,
          score: hit.score,
          ...(hit.meta ? { meta: hit.meta } : {}),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, 'Vector search failed');
      return reply.code(500).send({ error: 'vector_search_failed', detail: message });
    }
  });
}
