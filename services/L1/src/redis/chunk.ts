// src/redis/chunks.ts
import { getRedis } from './client';

const chunkKey = (chunkId: string) => `l1:chunk:${chunkId}`;
const itemChunksKey = (itemId: string) => `l1:item_chunks:${itemId}`;

export async function upsertChunks(
  ns: string,
  item_id: string,
  chunks: { seq: number; text: string; meta_json?: string }[],
  now = Date.now(),
  ttl_s?: number
) {
  const r = getRedis();
  const multi = r.multi();

  // replace membership set
  multi.del(itemChunksKey(item_id));

  for (const c of chunks) {
    const chunk_id = `${item_id}#${c.seq}`;
    multi.hset(chunkKey(chunk_id), {
      chunk_id,
      item_id,
      ns,
      seq: String(c.seq),
      text: c.text,
      meta_json: c.meta_json ?? '',
      created_at: String(now),
      updated_at: String(now),
    });
    multi.sadd(itemChunksKey(item_id), chunk_id);
    if (ttl_s && ttl_s > 0) multi.expire(chunkKey(chunk_id), ttl_s);
  }

  await multi.exec();
}

export async function setChunkVectors(
  item_id: string,
  vectors: { seq: number; vec: Float32Array }[],
  ttl_s?: number
) {
  const r = getRedis();
  const multi = r.multi();

  for (const { seq, vec } of vectors) {
    const chunk_id = `${item_id}#${seq}`;
    // Redis expects binary; convert Float32Array to Buffer
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    multi.hset(chunkKey(chunk_id), { vec: buf });
    if (ttl_s && ttl_s > 0) multi.expire(chunkKey(chunk_id), ttl_s);
  }

  await multi.exec();
}
