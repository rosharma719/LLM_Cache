import { describe, expect, it, vi } from 'vitest';
import type { ChunkPayload, CacheWritePayload, L1StorageBackend, VectorSearchResult } from '../src/contracts/l1Storage';
import type { SessionContext, AgentContext } from '../src/contracts/context';
import type { L2EventEnvelope, CacheWriteTrace } from '../src/contracts/l1l2';

describe('Contracts surface', () => {
  it('allows payloads to carry session/agent metadata', () => {
    const agent: AgentContext = { id: 'agent:demo', name: 'demo-agent', role: 'assistant' };
    const session: SessionContext = {
      sessionId: 'session-demo',
      namespace: 'demo',
      agents: [agent],
      metadata: { topic: 'contracts' },
    };

    const payload: CacheWritePayload = {
      ns: 'demo',
      text: 'hello cache',
      session,
      dedupe: true,
    };

    expect(payload.session).toBe(session);
    expect(payload.dedupe).toBe(true);
    expect(payload.session?.agents).toContain(agent);
  });

  it('forces storage backend implementations to satisfy the interface', async () => {
    const writeSpy = vi.fn(async (_payload, chunks) => ({
      itemId: 'demo:1',
      vectorized: chunks.length > 0,
    }));

    const backend: L1StorageBackend = {
      write: async (payload, chunks) => writeSpy(payload, chunks),
      read: async () => ({ item_id: 'demo:1', ns: 'demo', text: 'value', created_at: 1, updated_at: 2, version: 1 }),
      delete: async () => true,
      list: async () => ['demo:1'],
      setTTL: async () => true,
      getTTL: async () => 30,
      vectorSearch: async () => [
        {
          chunkId: 'demo:1#0',
          itemId: 'demo:1',
          namespace: 'demo',
          text: 'cached text',
          score: 0.15,
        },
      ],
    };

    const payload: CacheWritePayload = { ns: 'demo', text: 'hi' };
    const chunks: ChunkPayload[] = [{ seq: 0, text: 'hi' }];
    const result = await backend.write(payload, chunks);

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(result.vectorized).toBe(true);
    expect(result.itemId).toBe('demo:1');
  });

  it('round-trips L2 event envelopes with traces intact', () => {
    const trace: CacheWriteTrace = {
      recordId: 'trace:1',
      itemId: 'demo:1',
      session: { sessionId: 'session:1', namespace: 'demo' },
      query: 'hello?',
      vectorized: true,
    };

    const envelope: L2EventEnvelope = {
      session: trace.session,
      payload: { type: 'cache.write', trace },
    };

    const serialized = JSON.parse(JSON.stringify(envelope)) as L2EventEnvelope;
    expect(serialized.payload.trace).toMatchObject({ recordId: 'trace:1', vectorized: true });
  });
});
