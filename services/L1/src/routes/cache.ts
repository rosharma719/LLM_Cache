import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { upsertItem, getItem, deleteItem, listItemIds, getTTL, setTTL } from '../redis/kv';

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

    const id = await upsertItem({ ns, item_id, text, meta_json, ttl_s });
    return reply.send({ item_id: id });
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
