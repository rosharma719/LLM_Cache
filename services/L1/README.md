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

Copy `.env.example` to `.env` and set the following:

- `REDIS_URL` – connection string for your Redis instance (defaults to the Redis service in `docker-compose.yml`).
- `PORT` / `HOST` – network binding for the Fastify server.
- `EMBEDDING_PROVIDER` – currently `openai`.
- `OPENAI_API_KEY` – OpenAI API key with access to the embedding model.
- `OPENAI_EMBEDDING_MODEL` – defaults to `text-embedding-3-small`.
- `OPENAI_ORGANIZATION` – optional; sets the `OpenAI-Organization` header if your key is scoped to a non-default org (copy from the OpenAI dashboard).
- `OPENAI_PROJECT` – required for project-scoped keys (the default on new OpenAI accounts); sets the `OpenAI-Project` header.
- `L1_MAX_DISTANCE` – optional; cosine distance cutoff used by the demos/wrappers (defaults to `0.5`).
- `L1_TTL_SECONDS` – optional; default TTL applied by the demos when none is supplied.

## Run with Docker Compose

1. Install Docker + Docker Compose.
2. Stop any previous stack and clear volumes (safe to run even if nothing is running):

   ```bash
   docker compose down -v
   ```

3. Build a fresh L1 image to ensure the latest TypeScript output is used:

   ```bash
   docker compose build --no-cache l1
   ```

4. From the repository root, start the stack in detached mode (pass your `.env` so the container sees the embedding credentials, including any org/project headers):

   ```bash
   docker compose --env-file services/L1/.env up -d
   ```

   This brings up both the Redis Stack dependency and the L1 service. The API will listen on `http://localhost:8080`.

5. Follow the L1 application logs (Ctrl+C to stop tailing):

   ```bash
   docker logs -f l1-service
   ```

6. Verify the service health:

   ```bash
   curl -s localhost:8080/health
   ```

7. To stop and remove containers/volumes:

   ```bash
   docker compose down -v
   ```

## Local development

If you prefer running the TypeScript sources directly:

1. From `services/L1`, install dependencies with `npm ci`.
2. Launch Redis Stack in Docker from the repository root: `docker compose up -d redis`.
3. Start the dev server with hot reload:

   ```bash
   npm run dev
   ```

   Ensure `REDIS_URL=redis://127.0.0.1:6379` (or your custom URL) is set in `.env`.

## Tests

Vitest specs require Redis Stack for vector features.

1. Ensure dependencies are installed (`npm ci` inside `services/L1`).
2. From the repository root, start Redis Stack (if not already running): `docker compose up -d redis`.
3. From `services/L1`, set the Redis URL (or add it to `.env`) and run the individual commands listed in `src/testcommands.txt`, or execute the entire suite:

   ```bash
   export REDIS_URL=redis://127.0.0.1:6379
   npx vitest run
   ```

Remember to shut down Redis when finished with `docker compose down -v`.

## Demo: Cached OpenAI Chat Wrapper

`src/demo/cachedChat.ts` exports a lightweight helper that routes OpenAI chat prompts through the L1 cache. It first performs a vector similarity lookup; if a prior response is close enough it is returned immediately, otherwise the result from OpenAI is cached for future use.

```ts
import { CachedChatbot } from './demo/cachedChat';

const chat = new CachedChatbot({
  namespace: 'demo',
  baseUrl: 'http://localhost:8080',
  openAIApiKey: process.env.OPENAI_API_KEY!,
  // vectors must be within 0.85 cosine distance (override with maxDistance)
  maxDistance: 0.5,        // optional similarity cutoff (defaults to 0.5)
  ttlSeconds: 60 * 60,     // optional ttl for cached responses
});

const result = await chat.ask('How does vector search work?');
console.log(`[${result.source}] ${result.response}`);
```

Make sure the L1 service is running (along with Redis Stack and the embedding provider configuration) before using the wrapper.

### Gradio Demo

`src/demo/gradio_app.py` hosts an interactive playground. Set the same environment variables (including `L1_MAX_DISTANCE` if you want to tune cache hit thresholds) and run:

```bash
python services/L1/src/demo/gradio_app.py
```

The browser tab exposes:
- **Chat** – embeds the prompt, serves a cached response on vector hits, and writes fresh answers on misses.
- **Cache Browser** – list, inspect, and now delete (`/cache.delete`) individual cache entries.

### CLI Chat Demo

Prefer the terminal? `src/demo/chat_cli.py` offers a minimal ChatGPT-style loop that prints whether answers come from cache or OpenAI:

```bash
pip install requests
export OPENAI_API_KEY=sk-...
export L1_BASE_URL=http://localhost:8080
export L1_MAX_DISTANCE=0.5   # tweak in your shell before launching
python -m src.demo.chat_cli
```

Set `L1_MAX_DISTANCE` to tighten or loosen cache hits (defaults to `0.5` cosine distance).

### Vector Dedup Notes

- Exact repeats are stored under deterministic IDs (`dedup:<namespace>:<sha1(prompt)>`), so they never hit the vector index.
- Similar prompts reuse cached answers when the cosine distance is ≤ `L1_MAX_DISTANCE`. Increase the threshold (for example `0.8`) if you want looser matches.
- If you ever drop the RediSearch index (e.g. `docker exec redis-stack redis-cli FT.DROPINDEX idx:l1:chunks DD`), the next `/search.vector` call will recreate it with the correct embedding dimension—send a prompt afterwards to seed fresh vectors before testing hits.
