import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server';
import { getRedis } from '../src/redis/client';
import type { HTTPMethods } from 'fastify/types/utils';

type AppInstance = Awaited<ReturnType<typeof buildApp>>;
let app: AppInstance;
type MinimalInjectOptions = {
  method: HTTPMethods;
  url: string;
  payload?: unknown;
};
type MinimalInjectResponse = {
  statusCode: number;
  json(): unknown;
};

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

async function injectWithTiming(
  label: string,
  opts: MinimalInjectOptions,
): Promise<{ res: MinimalInjectResponse; ms: number }> {
  const start = performance.now();
  const res = (await app.inject(opts as any)) as unknown as MinimalInjectResponse;
  const ms = performance.now() - start;
  console.log(`[timings] ${label}: ${ms.toFixed(3)}ms`);
  return { res, ms };
}

describe('L1 KV - basics', () => {
  it('health returns ok', async () => {
    const { res } = await injectWithTiming('GET /health', { method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; redis: string };
    expect(body.status).toBe('ok');
    expect(body.redis).toBe('ok');
  });

  it('write -> get roundtrip', async () => {
    const { res: write } = await injectWithTiming('POST /cache.write (setup)', {
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'test', text: 'hello', ttl_s: 60 }
    });
    expect(write.statusCode).toBe(200);
    const { item_id } = write.json() as { item_id: string };
    expect(item_id).toMatch(/^test:/);

    const { res: read } = await injectWithTiming('GET /cache.get', {
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
    const { res: w1 } = await injectWithTiming('POST /cache.write (initial)', {
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'test', text: 'v1' }
    });
    const id = (w1.json() as any).item_id;

    // update with same id
    const { res: w2 } = await injectWithTiming('POST /cache.write (update same id)', {
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'test', item_id: id, text: 'v2' }
    });
    expect(w2.statusCode).toBe(200);

    const { res: read } = await injectWithTiming('GET /cache.get (after update)', {
      method: 'GET',
      url: `/cache.get?ns=test&item_id=${encodeURIComponent(id)}`
    });
    const obj = read.json() as any;
    expect(obj.text).toBe('v2');
    expect(obj.version).toBe(2);
    expect(obj.updated_at).toBeGreaterThan(obj.created_at);
  });

  it('namespace isolation: cannot read with wrong ns', async () => {
    const { res: w } = await injectWithTiming('POST /cache.write (ns isolation setup)', {
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'nsA', text: 'secret' }
    });
    const id = (w.json() as any).item_id;

    const { res: wrong } = await injectWithTiming('GET /cache.get (wrong namespace)', {
      method: 'GET',
      url: `/cache.get?ns=nsB&item_id=${encodeURIComponent(id)}`
    });
    expect(wrong.statusCode).toBe(404);
  });

  it('list returns ids', async () => {
    await injectWithTiming('POST /cache.write (list setup a)', { method: 'POST', url: '/cache.write', payload: { ns: 'listNS', text: 'a' } });
    await injectWithTiming('POST /cache.write (list setup b)', { method: 'POST', url: '/cache.write', payload: { ns: 'listNS', text: 'b' } });

    const { res } = await injectWithTiming('GET /cache.list', {
      method: 'GET',
      url: '/cache.list?ns=listNS&count=10'
    });
    expect(res.statusCode).toBe(200);
    const { item_ids } = res.json() as { item_ids: string[] };
    expect(Array.isArray(item_ids)).toBe(true);
    expect(item_ids.length).toBeGreaterThanOrEqual(2);
  });

  it('ttl can be set and read', async () => {
    const { res: w } = await injectWithTiming('POST /cache.write (ttl setup)', {
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'ttlNS', text: 'tmp', ttl_s: 2 }
    });
    const id = (w.json() as any).item_id;

    const { res: t1 } = await injectWithTiming('GET /cache.ttl (initial)', { method: 'GET', url: `/cache.ttl?item_id=${encodeURIComponent(id)}` });
    expect(t1.statusCode).toBe(200);
    const { ttl } = t1.json() as { ttl: number };
    expect(typeof ttl).toBe('number');
    expect(ttl).toBeGreaterThan(0);

    // also test /cache.ttl POST to extend
    const { res: set } = await injectWithTiming('POST /cache.ttl (extend)', {
      method: 'POST',
      url: '/cache.ttl',
      payload: { item_id: id, ttl_s: 10 }
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as any).ok).toBe(true);

    const { res: t2 } = await injectWithTiming('GET /cache.ttl (after extend)', { method: 'GET', url: `/cache.ttl?item_id=${encodeURIComponent(id)}` });
    const { ttl: ttl2 } = t2.json() as { ttl: number };
    expect(ttl2).toBeGreaterThanOrEqual(8);
  });

  it('delete removes the item', async () => {
    const { res: w } = await injectWithTiming('POST /cache.write (delete setup)', {
      method: 'POST',
      url: '/cache.write',
      payload: { ns: 'delNS', text: 'bye' }
    });
    const id = (w.json() as any).item_id;

    const { res: del } = await injectWithTiming('DELETE /cache.delete', {
      method: 'DELETE',
      url: '/cache.delete',
      payload: { ns: 'delNS', item_id: id }
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as any).ok).toBe(true);

    const { res: read } = await injectWithTiming('GET /cache.get (after delete)', {
      method: 'GET',
      url: `/cache.get?ns=delNS&item_id=${encodeURIComponent(id)}`
    });
    expect(read.statusCode).toBe(404);
  });

  it('bad inputs are rejected (400)', async () => {
    const { res } = await injectWithTiming('POST /cache.write (bad input)', {
      method: 'POST',
      url: '/cache.write',
      payload: { text: 'missing-ns' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('write -> get preserves meta (JSON roundtrip)', async () => {
  const { res: write } = await injectWithTiming('POST /cache.write (meta setup)', {
    method: 'POST',
    url: '/cache.write',
    payload: { ns: 'metaNS', text: 'with meta', meta: { a: 1, b: 'x' }, ttl_s: 30 },
  });
  expect(write.statusCode).toBe(200);
  const { item_id } = write.json() as { item_id: string };

  const { res: read } = await injectWithTiming('GET /cache.get (meta)', {
    method: 'GET',
    url: `/cache.get?ns=metaNS&item_id=${encodeURIComponent(item_id)}`,
  });
  expect(read.statusCode).toBe(200);
  const obj = read.json() as any;
  expect(obj.meta).toEqual({ a: 1, b: 'x' });
});

it('list returns ids with namespace prefix', async () => {
  await injectWithTiming('POST /cache.write (listNS2 setup a)', { method: 'POST', url: '/cache.write', payload: { ns: 'listNS2', text: 'a' } });
  await injectWithTiming('POST /cache.write (listNS2 setup b)', { method: 'POST', url: '/cache.write', payload: { ns: 'listNS2', text: 'b' } });

  const { res } = await injectWithTiming('GET /cache.list (namespace prefix)', {
    method: 'GET',
    url: '/cache.list?ns=listNS2&count=10',
  });
  expect(res.statusCode).toBe(200);
  const { item_ids } = res.json() as { item_ids: string[] };
  expect(item_ids.length).toBeGreaterThanOrEqual(2);
  for (const id of item_ids) expect(id.startsWith('listNS2:')).toBe(true);
});

it('ttl endpoint rejects bad inputs with 400', async () => {
  const { res: badTtl } = await injectWithTiming('POST /cache.ttl (bad input)', {
    method: 'POST',
    url: '/cache.ttl',
    payload: { item_id: 'x', ttl_s: -5 },
  });
  expect(badTtl.statusCode).toBe(400);
});

it('ttl can be extended (sanity check >= previous)', async () => {
  const { res: w } = await injectWithTiming('POST /cache.write (ttlNS2 setup)', {
    method: 'POST',
    url: '/cache.write',
    payload: { ns: 'ttlNS2', text: 'tmp', ttl_s: 2 },
  });
  const id = (w.json() as any).item_id;

  const { res: t1 } = await injectWithTiming('GET /cache.ttl (ttlNS2 initial)', { method: 'GET', url: `/cache.ttl?item_id=${encodeURIComponent(id)}` });
  const { ttl: ttl1 } = t1.json() as { ttl: number };
  expect(typeof ttl1).toBe('number');

  const { res: set } = await injectWithTiming('POST /cache.ttl (ttlNS2 extend)', {
    method: 'POST',
    url: '/cache.ttl',
    payload: { item_id: id, ttl_s: 10 },
  });
  expect(set.statusCode).toBe(200);

  const { res: t2 } = await injectWithTiming('GET /cache.ttl (ttlNS2 after extend)', { method: 'GET', url: `/cache.ttl?item_id=${encodeURIComponent(id)}` });
  const { ttl: ttl2 } = t2.json() as { ttl: number };
  expect(ttl2).toBeGreaterThan(ttl1);
});

});
