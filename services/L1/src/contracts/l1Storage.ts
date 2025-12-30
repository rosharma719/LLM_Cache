import type { ItemId, ItemRecord, Namespace, UpsertItemArgs } from '../types';
import type { SessionContext } from './context';

/** Known failure codes reported back to clients when vector staging fails. */
export type VectorErrorCode = 'vectorization_failed' | 'vector_store_failed';

/** Input payload describing the meaningful portions of a cache write request. */
export interface CacheWritePayload extends UpsertItemArgs {
  session?: SessionContext;
  dedupe?: boolean;
}

/** Standard response shape emitted by the storage backend after writing. */
export interface CacheWriteResult {
  itemId: ItemId;
  vectorized: boolean;
  vectorError?: VectorErrorCode;
  vectorErrorDetail?: string;
}

/** Augments the persisted item record with deserialized metadata and session context. */
export interface CacheEntry extends ItemRecord {
  meta?: Record<string, unknown>;
  session?: SessionContext;
}

/** Core chunk metadata shared between write and vectorize phases. */
export interface ChunkPayload {
  seq: number;
  text: string;
  meta?: Record<string, unknown>;
  vector?: Float32Array;
}

/** Describes the arguments for a vector similarity lookup. */
export interface VectorSearchInput {
  namespace: Namespace;
  query: string;
  topK?: number;
  maxDistance?: number;
  session?: SessionContext;
}

/** Result returned from a vector search, including score and optional provenance. */
export interface VectorSearchResult {
  chunkId: string;
  itemId: ItemId;
  namespace: Namespace;
  text: string;
  score: number;
  meta?: Record<string, unknown>;
}

/** Defines a pluggable storage backend that L1 routes and L2 coordinators can rely on. */
export interface L1StorageBackend {
  write(payload: CacheWritePayload, chunks: ChunkPayload[]): Promise<CacheWriteResult>;
  read(namespace: Namespace, itemId: ItemId): Promise<CacheEntry | null>;
  delete(namespace: Namespace, itemId: ItemId): Promise<boolean>;
  list(namespace: Namespace, count?: number): Promise<ItemId[]>;
  setTTL(itemId: ItemId, ttlSeconds: number): Promise<boolean>;
  getTTL(itemId: ItemId): Promise<number | null>;
  vectorSearch(query: VectorSearchInput): Promise<VectorSearchResult[]>;
}
