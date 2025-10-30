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

4. From the repository root, start the stack in detached mode:

   ```bash
   docker compose up -d
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
