import type { Namespace } from '../types';

/**
 * Lightweight metadata that identifies the agent emitting a request or processing a response.
 * Keeping this context small avoids leaking large payloads while still supporting provenance.
 */
export interface AgentContext {
  id: string;
  name?: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Describes a logical interaction session that potentially spans multiple agents or service hops.
 * This structure is passed along L1 ↔ L2 boundaries so provenance mixers and deduplicators
 * can correlate queries, cache entries, and stream fragments.
 */
export interface SessionContext {
  sessionId: string;
  namespace: Namespace;
  agents?: AgentContext[];
  metadata?: Record<string, unknown>;
}
