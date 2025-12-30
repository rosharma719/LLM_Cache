import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chunkText } from '../chunking/simple';
import { getEmbeddingProvider } from '../embeddings';
import { redisL1StorageBackend } from '../storage/redisL1Storage';
import type { ChunkPayload } from '../contracts/l1Storage';

// ---------- Schemas ----------
const writeSchema = z.object({
  ns: z.string().min(1, 'ns required'),
  item_id: z.string().min(1).optional(),
  text: z.string().min(1, 'text required'),
  meta: z.record(z.any()).optional(),
  ttl_s: z.number().int().positive().optional(), // seconds
});

const getSchema = z.object({
  ns: z.string().min(1),
  item_id: z.string().min(1),
});

const deleteSchema = getSchema;

const listQuerySchema = z.object({
  ns: z.string().min(1),
  // allow either string or number, then coerce to number
  count: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().positive().max(1000))
    .optional(),
});

const ttlSetSchema = z.object({
  item_id: z.string().min(1),
  ttl_s: z.number().int().positive(),
});

const ttlGetSchema = z.object({
  item_id: z.string().min(1),
});

const VECTOR_ERROR_EMBED = 'vectorization_failed';
const VECTOR_ERROR_STORE = 'vector_store_failed';

// ---------- Helper ----------
function badRequest(reply: any, parsed: Extract<z.SafeParseReturnType<any, any>, { success: false }>) {
  return reply.code(400).send({ error: parsed.error.flatten() });
}


// ---------- Routes ----------
export async function registerCacheRoutes(app: FastifyInstance) {
  // Write / upsert
  app.post('/cache.write', async (req, reply) => {
    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const { ns, item_id, text, meta, ttl_s } = parsed.data;

    // Safe stringify meta
    let meta_json: string | undefined;
    if (typeof meta !== 'undefined') {
      try {
        meta_json = JSON.stringify(meta);
      } catch {
        return reply.code(400).send({ error: 'meta must be JSON-serializable' });
      }
    }

    const chunks = chunkText(text);
    let vectorError: string | undefined;
    let vectors: Float32Array[] | undefined;
    const chunkPayloads: ChunkPayload[] = chunks.map((chunk) => ({
      seq: chunk.seq,
      text: chunk.text,
      vector: undefined as Float32Array | undefined,
    }));

    if (chunks.length > 0) {
      try {
        const provider = getEmbeddingProvider();
        vectors = await provider.embed(chunks.map((chunk) => chunk.text));
        if (vectors.length !== chunks.length) {
          throw new Error(`expected ${chunks.length} embeddings, received ${vectors.length}`);
        }
        chunkPayloads.forEach((payload, idx) => {
          payload.vector = vectors?.[idx];
        });
      } catch (err) {
        req.log.error({ err }, 'Vectorization failed for cache.write payload');
        vectorError = VECTOR_ERROR_EMBED;
      }
    }

    const result = await redisL1StorageBackend.write(
      { ns, item_id, text, meta_json, ttl_s },
      chunkPayloads,
    );

    if (result.vectorError === VECTOR_ERROR_STORE) {
      req.log.error(
        { detail: result.vectorErrorDetail },
        'Failed to persist chunk vectors',
      );
    }

    const response: Record<string, unknown> = { item_id: result.itemId, vectorized: result.vectorized };
    const combinedVectorError = vectorError ?? result.vectorError;
    if (combinedVectorError) response.vector_error = combinedVectorError;
    return reply.send(response);
  });

  // Read
  app.get('/cache.get', async (req, reply) => {
    const parsed = getSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);

    const { ns, item_id } = parsed.data;
    const item = await redisL1StorageBackend.read(ns, item_id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    return reply.send(item);
  });

  // Delete
  app.delete('/cache.delete', async (req, reply) => {
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const { ns, item_id } = parsed.data;
    const ok = await redisL1StorageBackend.delete(ns, item_id);
    return reply.send({ ok });
  });

  // List IDs (random sample via SRANDMEMBER)
  app.get('/cache.list', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);

    const ns = parsed.data.ns;
    const count = parsed.data.count ?? 100;
    const ids = await redisL1StorageBackend.list(ns, count);
    return reply.send({ item_ids: ids });
  });

  // Set TTL
  app.post('/cache.ttl', async (req, reply) => {
    const parsed = ttlSetSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const { item_id, ttl_s } = parsed.data;
    const ok = await redisL1StorageBackend.setTTL(item_id, ttl_s);
    return reply.send({ ok });
  });

  // Get TTL
  app.get('/cache.ttl', async (req, reply) => {
    const parsed = ttlGetSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);

    const { item_id } = parsed.data;
    const ttl = await redisL1StorageBackend.getTTL(item_id);
    return reply.send({ ttl });
  });
}
