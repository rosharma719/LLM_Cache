import { getRedis } from './client';
import type { EmbeddingProvider } from '../embeddings/provider';

const INDEX_NAME = 'idx:l1:chunks';
const CHUNK_PREFIX = 'l1:chunk:';
const VECTOR_FIELD = 'vec';

let indexReady = false;
let ensuring: Promise<void> | null = null;

export async function ensureChunkVectorIndex(provider: EmbeddingProvider): Promise<void> {
  if (indexReady) return;
  if (!ensuring) {
    ensuring = doEnsure(provider)
      .then(() => {
        indexReady = true;
      })
      .finally(() => {
        ensuring = null;
      });
  }
  return ensuring;
}

async function doEnsure(provider: EmbeddingProvider): Promise<void> {
  const redis = getRedis();

  // Ensure RediSearch is available
  try {
    const existing = await redis.call('FT._LIST');
    if (Array.isArray(existing)) {
      const names = existing.map((idx) => toSafeString(idx));
      if (names.includes(INDEX_NAME)) return;
    }
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message : String(err);
    if (message.includes('unknown command') || message.includes('ERR unknown command')) {
      throw new Error('RediSearch module is required for vector search. Ensure Redis Stack is running.');
    }
    throw err;
  }

  const dim = provider.dim;
  if (!dim) {
    throw new Error('Embedding provider did not report a vector dimension; cannot create vector index.');
  }

  const args: Array<string | number> = [
    INDEX_NAME,
    'ON',
    'HASH',
    'PREFIX',
    '1',
    CHUNK_PREFIX,
    'SCHEMA',
    'ns',
    'TAG',
    'SEPARATOR',
    '|',
    'item_id',
    'TAG',
    'text',
    'TEXT',
    'meta_json',
    'TEXT',
    VECTOR_FIELD,
    'VECTOR',
    'FLAT',
    '6',
    'TYPE',
    'FLOAT32',
    'DIM',
    String(dim),
    'DISTANCE_METRIC',
    'COSINE',
  ];

  try {
    await redis.call('FT.CREATE', ...args);
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message : String(err);
    if (message.includes('Index already exists')) {
      return;
    }
    throw err;
  }
}

function toSafeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value ?? '');
}

export const chunkIndex = {
  name: INDEX_NAME,
  vectorField: VECTOR_FIELD,
  prefix: CHUNK_PREFIX,
};
