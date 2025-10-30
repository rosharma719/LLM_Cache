import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { upsertItem, getItem, deleteItem, listItemIds, getTTL, setTTL } from '../redis/kv';
import { chunkText } from '../chunking/simple';
import { getEmbeddingProvider } from '../embeddings';
import { upsertChunks } from '../redis/chunk';

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
    let vectors: Float32Array[] | undefined;
    let vectorError: string | undefined;

    if (chunks.length > 0) {
      try {
        const provider = getEmbeddingProvider();
        vectors = await provider.embed(chunks.map((chunk) => chunk.text));
        if (vectors.length !== chunks.length) {
          throw new Error(`expected ${chunks.length} embeddings, received ${vectors.length}`);
        }
      } catch (err) {
        req.log.error({ err }, 'Vectorization failed for cache.write payload');
        vectorError = VECTOR_ERROR_EMBED;
        vectors = undefined;
      }
    }

    const id = await upsertItem({ ns, item_id, text, meta_json, ttl_s });

    let vectorized = false;
    if (!vectorError && chunks.length > 0 && vectors) {
      try {
        const now = Date.now();
        await upsertChunks(
          ns,
          id,
          chunks.map((chunk) => ({
            seq: chunk.seq,
            text: chunk.text,
            meta_json,
          })),
          vectors,
          now,
          ttl_s,
        );
        vectorized = true;
      } catch (err) {
        req.log.error({ err }, 'Failed to persist chunk vectors');
        vectorError = VECTOR_ERROR_STORE;
      }
    }

    const response: Record<string, unknown> = { item_id: id, vectorized };
    if (vectorError) response.vector_error = vectorError;

    return reply.send(response);
  });

  // Read
  app.get('/cache.get', async (req, reply) => {
    const parsed = getSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);

    const { ns, item_id } = parsed.data;
    const item = await getItem(ns, item_id);
    if (!item) return reply.code(404).send({ error: 'not_found' });

    // Parse meta_json back to object (ignore parse errors gracefully)
    let meta: unknown | undefined;
    if (item.meta_json) {
      try {
        meta = JSON.parse(item.meta_json);
      } catch {
        meta = undefined;
      }
    }
    return reply.send({ ...item, meta });
  });

  // Delete
  app.delete('/cache.delete', async (req, reply) => {
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const { ns, item_id } = parsed.data;
    const ok = await deleteItem(ns, item_id);
    return reply.send({ ok });
  });

  // List IDs (random sample via SRANDMEMBER)
  app.get('/cache.list', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);

    const ns = parsed.data.ns;
    const count = parsed.data.count ?? 100;
    const ids = await listItemIds(ns, count);
    return reply.send({ item_ids: ids });
  });

  // Set TTL
  app.post('/cache.ttl', async (req, reply) => {
    const parsed = ttlSetSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const { item_id, ttl_s } = parsed.data;
    const ok = await setTTL(item_id, ttl_s);
    return reply.send({ ok });
  });

  // Get TTL
  app.get('/cache.ttl', async (req, reply) => {
    const parsed = ttlGetSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);

    const { item_id } = parsed.data;
    const ttl = await getTTL(item_id);
    return reply.send({ ttl });
  });
}
