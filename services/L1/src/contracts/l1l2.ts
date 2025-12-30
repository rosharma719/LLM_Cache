import type { ItemId } from '../types';
import type { VectorSearchInput, VectorSearchResult } from './l1Storage';
import type { AgentContext, SessionContext } from './context';

/** Source identifier used when tracing where a response originated. */
export type ProvenanceSource = 'l1' | 'l2' | 'llm' | 'external';

/** Snapshot describing what happened to a single prompt/response pair during a session. */
export interface ProvenanceRecord {
  eventId: string;
  session: SessionContext;
  agent?: AgentContext;
  itemId: ItemId;
  query: string;
  response?: string;
  cached: boolean;
  source: ProvenanceSource;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Trace emitted each time a new cache entry is persisted so L2 can reconcile it. */
export interface CacheWriteTrace {
  recordId: string;
  itemId: ItemId;
  session: SessionContext;
  agent?: AgentContext;
  query: string;
  response?: string;
  vectorized: boolean;
  metadata?: Record<string, unknown>;
}

/** Request shape sent from agents or clients that expect L2 coordination. */
export interface L2SearchRequest extends VectorSearchInput {
  requestId: string;
  agent?: AgentContext;
  preferFresh?: boolean;
}

/** Stream-friendly frame used when L2 fans out vector hits or cached responses. */
export interface L2SearchResponse {
  requestId: string;
  session: SessionContext;
  hits: Array<VectorSearchResult & { provenance?: ProvenanceRecord }>;
  cursor?: string;
}

/** Minimal cross-agent handshake so L2 can broker cache read/write notifications. */
export interface L2EventEnvelope {
  session: SessionContext;
  payload: { type: string; trace: CacheWriteTrace | ProvenanceRecord };
}
