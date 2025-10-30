# LLM-Optimized Cache

This repository implements a two-tier cache system optimized for LLM and agent coordination workloads.

It provides:
- High-speed key–value operations (L1)
- Vector and agentic search abstractions
- Cross-agent, session-level provenance and coordination (L2)

The architecture enables runtime memory, deduplication, and distributed search for multi-agent or multi-LLM systems.

## Quick start

1. Stop any previous stack and clear volumes (safe to run even if nothing is running):

   ```bash
   docker compose down -v
   ```

2. Build a fresh L1 image (skips the cache so new TypeScript builds get picked up):

   ```bash
   docker compose build --no-cache l1
   ```

3. Start the services (Redis Stack + L1) in detached mode:

   ```bash
   docker compose up -d
   ```

4. Follow the L1 application logs (Ctrl+C to stop tailing):

   ```bash
   docker logs -f l1-service
   ```

5. Verify the API is healthy:

   ```bash
   curl -s localhost:8080/health
   ```

6. (Optional) Run the L1 test suite from `services/L1`:

   ```bash
   export REDIS_URL=redis://127.0.0.1:6379
   npx vitest run
   ```

7. Tear everything down:

   ```bash
   docker compose down -v
   ```

Environment variable details live in the service-specific README files under `services/`.
