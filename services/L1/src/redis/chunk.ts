// src/redis/chunks.ts
import { getRedis } from './client';

const chunkKey = (chunkId: string) => `l1:chunk:${chunkId}`;
const itemChunksKey = (itemId: string) => `l1:item_chunks:${itemId}`;

export async function upsertChunks(
  ns: string,
  item_id: string,
  chunks: { seq: number; text: string; meta_json?: string }[],
  vectors?: Float32Array[],
  now = Date.now(),
  ttl_s?: number
) {
  if (chunks.length === 0) return;

  const redis = getRedis();
  const multi = redis.multi();

  multi.del(itemChunksKey(item_id));

  chunks.forEach((chunk, idx) => {
    const chunk_id = `${item_id}#${chunk.seq}`;
    const payload: Record<string, string | Buffer> = {
      chunk_id,
      item_id,
      ns,
      seq: String(chunk.seq),
      text: chunk.text,
      meta_json: chunk.meta_json ?? '',
      created_at: String(now),
      updated_at: String(now),
    };

    const vec = vectors?.[idx];
    if (vec) {
      payload.vec = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    }

    multi.hset(chunkKey(chunk_id), payload);
    multi.sadd(itemChunksKey(item_id), chunk_id);
    if (ttl_s && ttl_s > 0) {
      multi.expire(chunkKey(chunk_id), ttl_s);
    }
  });

  await multi.exec();
}
