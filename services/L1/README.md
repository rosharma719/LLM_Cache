# L1 LLM-Optimized Cache

This is a cache with features optimized for LLM use. This will include: 
- Automatic query/response storage 
- Automatic chunking and vectorization
- Automatic query deduplication

Eventually, this will connect to a session-wide L2 cache, enabling:
- Distributed search across the session
- Session-wide provenance across agents
- Query/response streaming between agents

## Environment

Copy `.env.example` to `.env` and set:

- `REDIS_URL` – connection string for your Redis instance.
- `PORT` / `HOST` – network binding for the Fastify server.
- `EMBEDDING_PROVIDER` – currently `openai`.
- `OPENAI_API_KEY` – OpenAI API key with access to the embedding model.
- `OPENAI_EMBEDDING_MODEL` – defaults to `text-embedding-3-small`.
