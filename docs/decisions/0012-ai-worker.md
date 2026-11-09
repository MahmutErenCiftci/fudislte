# ADR-0012: Optional AI worker as a separate internal Python service

Status: Accepted · Phases 8–9

## Context
Phase 8 adds transcription, meeting and channel summaries, permission-aware retrieval and
task suggestions; Phase 9 adds agents that act in FUDISLTE. The product rule is strict: AI
is optional, local-first, permission-aware and never invents decisions, and every core
feature must work with AI disabled. The local model ecosystem (faster-whisper, Ollama,
vLLM, embedding models) is Python- and HTTP-based; the API is a Go monolith (ADR-0002)
that anticipated splitting the AI worker out over an explicit API.

## Decision
- **A separate service**, `services/ai` (Python 3.12, FastAPI, uvicorn, pydantic, httpx,
  asyncpg — all permissive licenses), called only by the API. It is internal: no published
  port, never behind Caddy, on Compose networks without an internet route, added by an
  overlay (`compose.ai.yml`) that the API does not depend on.
- **Authenticated with a shared secret:** every request carries
  `X-FUDISLTE-Timestamp` and `X-FUDISLTE-Signature: v1=HMAC-SHA256(secret, timestamp + "." +
  METHOD + "." + request target + "." + body)`, where the request target is the raw path
  plus `?query` exactly as sent (e.g. `1767225600.POST./v1/summarize.{"hello":"world"}`);
  skew over 300 seconds is refused; comparison is constant-time. Binding method and target
  means a signature is valid only for the one request it was made for. The worker signs its
  callbacks to the API the same way.
- **Models stay local by default.** Ollama or any OpenAI-compatible server (vLLM) over
  plain HTTP, faster-whisper in-process as an optional extra. A model URL outside the
  private network is refused unless the operator sets `FUDISLTE_AI_ALLOW_EXTERNAL_LLM=true`
  (and uses https); the health endpoint reports it.
- **Capabilities are independent and discoverable:** `GET /healthz` lists `llm`,
  `embeddings`, `transcription`; a missing one answers `503 capability_disabled`.
- **Citations are enforced in code, not only asked for.** Decisions, action items and task
  suggestions must cite ids from the input; others are removed, entries without a valid
  citation are dropped and counted. Suggestions are only suggestions: a person creates the
  task through the normal API.
- **The API decides permissions; the worker filters.** Chunks carry an ACL id chosen by the
  API; search takes the caller's `allowedAclIds` and filters inside the SQL query that ranks
  by vector distance (pgvector, HNSW with iterative scans). The index lives in the worker's
  own PostgreSQL (`pgvector/pgvector` image) as derived, rebuildable data.
- **Agents are bounded and cannot act on their own.** Tools are schemas with a
  `destructive` flag; all of them are executed by the API as the delegating person with a
  per-run token. There are no shell, file or network tools. A destructive call pauses the
  run with the canonical arguments and their SHA-256 hash; only an approval naming that
  action and hash executes it, exactly once. Limits: model steps, tool calls, active wall
  time. Every step is audited. Runs live in memory with a TTL; the API stores the
  authoritative record.

## Consequences
- A second runtime (Python) and image to maintain, and two extra containers (worker and its
  database) when AI is enabled; none when it is not.
- Content copied into the vector index must follow deletions and retention: the API calls
  `DELETE /v1/index` when content goes away.
- One worker instance (in-memory runs). Several replicas need a shared run store.
- The remaining replay risk is an identical request (same method, target and body) sent
  again within the 300-second window by an attacker already able to capture traffic on the
  internal network. Approvals stay single use, so a replayed approval is refused.
- Model quality, Turkish output and GPU paths must be evaluated per installation; the
  default image is CPU-only and ships without Whisper (its PyAV dependency bundles LGPL
  FFmpeg libraries, reviewed before distribution).
