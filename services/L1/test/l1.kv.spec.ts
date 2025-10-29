import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server';
import { getRedis } from '../src/redis/client';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  // Ensure Redis is up and clean
  const r = getRedis();
  await r.ping();
  await r.flushall(); // isolate test DB; OK for local tests
  app = await buildApp();
});

afterAll(async () => {
  const r = getRedis();
  await r.quit();
  await app.close();
});

beforeEach(async () => {
  // no-op; you could flush here instead of in individual tests if needed
});

describe('L1 KV - basics', () => {
  it('health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; redis: string };
    expect(body.status).toBe('ok');
    expect(body.redis).toBe('ok');
  });

  it('write -> get roundtrip', async () => {
    const write = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'test', text: 'hello', ttl_s: 60 }
    });
    expect(write.statusCode).toBe(200);
    const { item_id } = write.json() as { item_id: string };
    expect(item_id).toMatch(/^test:/);

    const read = await app.inject({
      method: 'GET',
      url: `/cache.get?ns=test&item_id=${encodeURIComponent(item_id)}`
    });
    expect(read.statusCode).toBe(200);
    const obj = read.json() as any;
    expect(obj.text).toBe('hello');
    expect(obj.version).toBe(1);
    expect(obj.ns).toBe('test');
  });

  it('update same item_id increments version', async () => {
    // initial write
    const w1 = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'test', text: 'v1' }
    });
    const id = (w1.json() as any).item_id;

    // update with same id
    const w2 = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'test', item_id: id, text: 'v2' }
    });
    expect(w2.statusCode).toBe(200);

    const read = await app.inject({
      method: 'GET',
      url: `/cache.get?ns=test&item_id=${encodeURIComponent(id)}`
    });
    const obj = read.json() as any;
    expect(obj.text).toBe('v2');
    expect(obj.version).toBe(2);
    expect(obj.updated_at).toBeGreaterThan(obj.created_at);
  });

  it('namespace isolation: cannot read with wrong ns', async () => {
    const w = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'nsA', text: 'secret' }
    });
    const id = (w.json() as any).item_id;

    const wrong = await app.inject({
      method: 'GET',
      url: `/cache.get?ns=nsB&item_id=${encodeURIComponent(id)}`
    });
    expect(wrong.statusCode).toBe(404);
  });

  it('list returns ids', async () => {
    await app.inject({ method: 'POST', url: '/cache.write', payload: { ns: 'listNS', text: 'a' } });
    await app.inject({ method: 'POST', url: '/cache.write', payload: { ns: 'listNS', text: 'b' } });

    const res = await app.inject({
      method: 'GET',
      url: '/cache.list?ns=listNS&count=10'
    });
    expect(res.statusCode).toBe(200);
    const { item_ids } = res.json() as { item_ids: string[] };
    expect(Array.isArray(item_ids)).toBe(true);
    expect(item_ids.length).toBeGreaterThanOrEqual(2);
  });

  it('ttl can be set and read', async () => {
    const w = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'ttlNS', text: 'tmp', ttl_s: 2 }
    });
    const id = (w.json() as any).item_id;

    const t1 = await app.inject({ method: 'GET', url: `/cache.ttl?item_id=${encodeURIComponent(id)}` });
    expect(t1.statusCode).toBe(200);
    const { ttl } = t1.json() as { ttl: number };
    expect(typeof ttl).toBe('number');
    expect(ttl).toBeGreaterThan(0);

    // also test /cache.ttl POST to extend
    const set = await app.inject({
      method: 'POST',
      url: '/cache.ttl',
      payload: { item_id: id, ttl_s: 10 }
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as any).ok).toBe(true);

    const t2 = await app.inject({ method: 'GET', url: `/cache.ttl?item_id=${encodeURIComponent(id)}` });
    const { ttl: ttl2 } = t2.json() as { ttl: number };
    expect(ttl2).toBeGreaterThanOrEqual(8);
  });

  it('delete removes the item', async () => {
    const w = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'delNS', text: 'bye' }
    });
    const id = (w.json() as any).item_id;

    const del = await app.inject({
      method: 'DELETE',
      url: '/cache.delete',
      payload: { ns: 'delNS', item_id: id }
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as any).ok).toBe(true);

    const read = await app.inject({
      method: 'GET',
      url: `/cache.get?ns=delNS&item_id=${encodeURIComponent(id)}`
    });
    expect(read.statusCode).toBe(404);
  });

  it('bad inputs are rejected (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cache.write',
      payload: { text: 'missing-ns' }
    });
    expect(res.statusCode).toBe(400);
  });
});
