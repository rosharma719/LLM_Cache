import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { upsertItem, getItem, deleteItem, listItemIds, getTTL, setTTL } from '../redis/kv';

const writeSchema = z.object({
  ns: z.string().min(1),
  item_id: z.string().optional(),
  text: z.string().min(1),
  meta: z.record(z.any()).optional(),
  ttl_s: z.number().int().positive().optional(),
});

export async function registerCacheRoutes(app: FastifyInstance) {
  app.post('/cache.write', async (req, reply) => {
    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { ns, item_id, text, meta, ttl_s } = parsed.data;
    const meta_json = meta ? JSON.stringify(meta) : undefined;
    const id = await upsertItem({ ns, item_id, text, meta_json, ttl_s });
    return reply.send({ item_id: id });
  });

  app.get('/cache.get', async (req, reply) => {
    const query = z.object({ ns: z.string().min(1), item_id: z.string().min(1) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });

    const { ns, item_id } = query.data;
    const item = await getItem(ns, item_id);
    if (!item) return reply.code(404).send({ error: 'not_found' });

    const meta = item.meta_json ? JSON.parse(item.meta_json) : undefined;
    return reply.send({ ...item, meta });
  });

  app.delete('/cache.delete', async (req, reply) => {
    const parsed = z.object({ ns: z.string().min(1), item_id: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { ns, item_id } = parsed.data;
    const ok = await deleteItem(ns, item_id);
    return reply.send({ ok });
  });

  app.get('/cache.list', async (req, reply) => {
    const query = z.object({ ns: z.string().min(1), count: z.string().optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const count = query.data.count ? Number(query.data.count) : 100;
    const ids = await listItemIds(query.data.ns, count);
    return reply.send({ item_ids: ids });
  });

  app.post('/cache.ttl', async (req, reply) => {
    const parsed = z.object({ item_id: z.string().min(1), ttl_s: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { item_id, ttl_s } = parsed.data;
    const ok = await setTTL(item_id, ttl_s);
    return reply.send({ ok });
  });

  app.get('/cache.ttl', async (req, reply) => {
    const query = z.object({ item_id: z.string().min(1) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const { item_id } = query.data;
    const ttl = await getTTL(item_id);
    return reply.send({ ttl });
  });
}
