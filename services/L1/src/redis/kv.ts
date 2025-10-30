import { getRedis } from './client';
import type { ItemRecord, ItemId, Namespace, UpsertItemArgs } from '../types';

const itemKey = (itemId: ItemId) => `l1:item:${itemId}`;
const nsItemsKey = (ns: Namespace) => `l1:ns:${ns}:items`;

export async function upsertItem(rec: UpsertItemArgs): Promise<ItemId> {
  const redis = getRedis();

  const item_id: ItemId = rec.item_id ?? genItemId(rec.ns);
  const key = itemKey(item_id);

  const now = Date.now();

  const [prevCreatedRaw, prevVersionRaw] = await redis.hmget(key, 'created_at', 'version');
  const hasExisting = Boolean(prevCreatedRaw);
  const created_at = prevCreatedRaw ? Number(prevCreatedRaw) : now;

  // ensure updated_at is strictly > created_at on updates
  const updated_at = hasExisting && now <= created_at ? created_at + 1 : now;

  const version = prevVersionRaw ? Number(prevVersionRaw) + 1 : 1;

  const multi = redis.multi();

  multi.hset(key, {
    item_id,
    ns: rec.ns,
    text: rec.text,
    meta_json: rec.meta_json ?? '',
    created_at: String(created_at),
    updated_at: String(updated_at),           // <-- use monotonic value
    ttl_s: rec.ttl_s ? String(rec.ttl_s) : '',
    version: String(version),
  });

  multi.sadd(nsItemsKey(rec.ns), item_id);

  if (rec.ttl_s && rec.ttl_s > 0) {
    multi.expire(key, rec.ttl_s);
  }
  await multi.exec();

  return item_id;
}



export async function getItem(ns: Namespace, item_id: ItemId): Promise<ItemRecord | null> {
  const redis = getRedis();
  const key = itemKey(item_id);
  const hash = await redis.hgetall(key);
  if (!hash || Object.keys(hash).length === 0) return null;
  if (hash.ns !== ns) return null;

  return {
    item_id: hash.item_id,
    ns: hash.ns,
    text: hash.text,
    meta_json: hash.meta_json || undefined,
    created_at: Number(hash.created_at),
    updated_at: Number(hash.updated_at),
    ttl_s: hash.ttl_s ? Number(hash.ttl_s) : undefined,
    version: Number(hash.version || '1'),
  };
}

export async function deleteItem(ns: Namespace, item_id: ItemId): Promise<boolean> {
  const redis = getRedis();
  const key = itemKey(item_id);
  const existing = await redis.hget(key, 'ns');
  if (!existing || existing !== ns) return false;

  await redis.multi()
    .del(key)
    .srem(nsItemsKey(ns), item_id)
    .exec();

  return true;
}

export async function listItemIds(ns: Namespace, count = 100): Promise<ItemId[]> {
  const redis = getRedis();
  const ids = await redis.srandmember(nsItemsKey(ns), count);
  return ids || [];
}

export async function getTTL(item_id: ItemId): Promise<number | null> {
  const redis = getRedis();
  const ttl = await redis.ttl(itemKey(item_id));
  if (ttl === -2) return null; // missing
  if (ttl === -1) return -1;   // no ttl set
  return ttl;
}

export async function setTTL(item_id: ItemId, ttl_s: number): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.expire(itemKey(item_id), ttl_s);
  return res === 1;
}

function genItemId(ns: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ns}:${Date.now()}:${rand}`;
}
