# AI Worker — Optional AI Assistant and Agents (Phases 8–9)

Status: **worker implemented and tested; Go API integration not started.** Design
decisions: [ADR-0012](../decisions/0012-ai-worker.md). This document is the contract the
Go API is built against; §13 is the checklist for the API side.

The AI worker (`services/ai`, Python 3.12, FastAPI) is a separate internal service that
the FUDISLTE API calls. It transcribes audio, summarizes meetings and channels, indexes
content for permission-aware retrieval, suggests tasks and runs bounded agents. Product
rules it follows:

- **Optional.** FUDISLTE works fully without it. Every capability can be off; the API treats
  "not configured", `503 capability_disabled` and "unreachable" the same way: the AI
  feature is hidden or answers "unavailable", nothing else changes.
- **Local-first.** Models run on the organization's own hardware (Ollama, vLLM,
  faster-whisper). A model server outside the server's private network is refused unless
  the operator explicitly allows it (§7, §8).
- **Permission-aware.** The worker never decides who may read what. The API computes the
  set of ACL ids the person may read; the search filters by it inside SQL (§5.3). Agent
  tools act through the API as the delegating person, with the API's normal checks (§6).
- **Never invents decisions.** Every decision, action item and task suggestion cites input
  item ids; the code removes citations to ids that were not in the input and drops
  entries left without one (§5.2). Destructive agent actions never run without a person's
  approval of that exact call (§6.3).

## 1. Components

```
Browser / desktop ──► Caddy ──► FUDISLTE API ──(HMAC, network "ai")──► AI worker ──► model server
                                     ▲                                  │  (Ollama / vLLM,
                                     └── agent tool callbacks ──────────┤   network "ai-backend")
                                         /internal/ai/tools/{tool}      └──► ai-postgres (pgvector)
```

| Part | Where | Notes |
| --- | --- | --- |
| `fudislte_ai.auth` | Signature middleware | Verifies every request before any route sees the body |
| `fudislte_ai.grounded` | `/v1/summarize`, `/v1/suggest-tasks` | Prompts + citation enforcement; long inputs in batches |
| `fudislte_ai.store` | `/v1/index`, `/v1/search` | asyncpg + pgvector, tables created at start |
| `fudislte_ai.transcribe` | `/v1/transcribe` | faster-whisper, optional extra, one job at a time |
| `fudislte_ai.agents` | `/v1/agents/*` | Tool registry, loop, approvals, audit, in-memory runs |
| `fudislte_ai.llm` | — | Ollama (`/api/chat`, `/api/embed`) and OpenAI-compatible (`/chat/completions`, `/embeddings`) over plain httpx |

The worker publishes no port and is never routed through Caddy (Caddy proxies only
`/api/*` and `/livekit/*`). In Compose it shares the internal network `ai` with the API
only; its database and the optional Ollama are on a second internal network (§9).

## 2. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FUDISLTE_AI_SHARED_SECRET` | — (required, ≥ 32 characters) | HMAC key shared with the API (`openssl rand -hex 32`) |
| `FUDISLTE_AI_HTTP_ADDR` | `:8090` | Listen address |
| `FUDISLTE_AI_LLM_KIND` | `none` | `ollama`, `openai` (any OpenAI-compatible server: vLLM, llama.cpp server, LocalAI) or `none` |
| `FUDISLTE_AI_LLM_URL` | — | Ollama: `http://ollama:11434`; OpenAI-compatible: the API base incl. `/v1`, e.g. `http://vllm:8000/v1` |
| `FUDISLTE_AI_LLM_MODEL` | empty | Chat model; empty disables summaries, suggestions and agents |
| `FUDISLTE_AI_LLM_API_KEY` | empty | Sent as `Authorization: Bearer` (vLLM `--api-key`, hosted APIs) |
| `FUDISLTE_AI_EMBED_MODEL` | empty | Embedding model; empty disables index and search |
| `FUDISLTE_AI_EMBED_URL` | `FUDISLTE_AI_LLM_URL` | Separate embedding server (vLLM runs one model per server) |
| `FUDISLTE_AI_EMBED_DIM` | `768` | Embedding dimensions, 1–2000 (pgvector HNSW limit); must match the model |
| `FUDISLTE_AI_DATABASE_URL` | — (required with an embedding model) | PostgreSQL with pgvector, `postgres://…` |
| `FUDISLTE_AI_ALLOW_EXTERNAL_LLM` | `false` | Must be `true` (and the URL `https://`) for a model server outside the private network |
| `FUDISLTE_AI_WHISPER_MODEL` | empty | faster-whisper model name or local directory; empty disables transcription |
| `FUDISLTE_AI_WHISPER_DEVICE` / `FUDISLTE_AI_WHISPER_COMPUTE_TYPE` | `auto` / `default` | `cpu`, `cuda` or `auto`; CTranslate2 compute type (e.g. `int8`) |
| `FUDISLTE_AI_MODEL_DIR` | `/models` in the image | Where Whisper models are looked up / cached |
| `FUDISLTE_AI_API_URL` | `http://api:8080` | Base URL for agent tool callbacks to the API |
| `FUDISLTE_AI_LLM_TIMEOUT_SECONDS` | `120` | Per model request |
| `FUDISLTE_AI_LLM_CONCURRENCY` | `4` | Model requests in flight at once (chat and embeddings together); more wait, at most the timeout, then fail with `llm_unavailable` |
| `FUDISLTE_AI_MAX_BODY_MB` / `FUDISLTE_AI_MAX_AUDIO_MB` | `8` / `100` | Request size limits (JSON / `/v1/transcribe`) |
| `FUDISLTE_AI_RUN_TTL_SECONDS` / `FUDISLTE_AI_MAX_RUNS` | `86400` / `200` | Agent runs kept in memory after their last change; how many at most |
| `FUDISLTE_AI_LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error` |

Invalid configuration stops the worker at start with every problem listed. A capability
whose backend fails at start (for example the database) is reported as `false` and logged;
the others keep working.

**API side (new):** `FUDISLTE_AI_URL` (e.g. `http://ai:8090`; empty = AI disabled) and
`FUDISLTE_AI_SHARED_SECRET` (same value as the worker's). The Compose overlay sets both.

## 3. Authentication

Every request to the worker except `GET /healthz` carries:

```
X-FUDISLTE-Timestamp: <Unix time in seconds, ASCII digits>
X-FUDISLTE-Signature: v1=<lowercase hex HMAC-SHA256(secret, signed string)>

signed string = timestamp + "." + METHOD + "." + request target + "." + raw body
```

- `METHOD` is the HTTP method in upper case (`GET`, `POST`, `DELETE`).
- The **request target** is what goes on the HTTP request line: the raw path exactly as
  sent (still percent-encoded), plus `?` and the raw query string when the query string is
  not empty — no scheme, host or port (never send a URL ending in a bare `?`: Go would
  sign the `?`, the worker sees no query). The worker takes it from ASGI `scope["raw_path"]`
  and `scope["query_string"]`; Go uses `r.Method` and `r.URL.RequestURI()` (for an
  outgoing request that is the target `net/http` writes on the request line; on the
  server, FUDISLTE's paths are plain ASCII, so it equals the received `r.RequestURI`).
- The **raw body** is the exact bytes sent (for multipart: the whole encoded multipart
  body). A request without a body ends the signed string with the last `.`.
- The worker rejects a timestamp more than **300 seconds** from its clock, compares the
  signature in constant time, and reads at most the size limit before checking.
- Failures answer `401` with `signature_missing`, `timestamp_invalid`, `timestamp_expired`
  or `signature_invalid`; over-size bodies `413 body_too_large`. Unsigned requests to
  unknown paths also get 401, so routes are not disclosed.
- The worker's calls back to the API (§6.4) are signed the same way with the same secret:
  method `POST`, target `/internal/ai/tools/{tool}` (including any path prefix of
  `FUDISLTE_AI_API_URL`).

Worked examples (secret `0123456789abcdef0123456789abcdef`; asserted in
`tests/test_auth.py`, and `scripts/wsl/ai-docker-check.sh` signs the same way with
`openssl dgst -sha256 -hmac`):

| Request | Signed string | `X-FUDISLTE-Signature` |
| --- | --- | --- |
| `POST /v1/summarize`, body `{"hello":"world"}`, timestamp `1767225600` | `1767225600.POST./v1/summarize.{"hello":"world"}` | `v1=285f6e5651d72488cf206fc8c15018852981cc64e4fc6400cfffecde0a121c1e` |
| `GET /v1/agents/runs/abc?x=1`, no body, timestamp `1767225600` | `1767225600.GET./v1/agents/runs/abc?x=1.` | `v1=a56d00d3ffbff6dbb26b579f1fac6d808b645c2cc96ad6368b216849fb0d504e` |

Go:

```go
// signature returns the v1 header value. target is r.URL.RequestURI(); body is the
// exact bytes sent (or received).
func signature(secret []byte, timestamp, method, target string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	io.WriteString(mac, timestamp+"."+strings.ToUpper(method)+"."+target+".")
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

// Outgoing (API -> worker): sign with the body you send; new timestamp per attempt.
func signRequest(req *http.Request, secret, body []byte, now time.Time) {
	ts := strconv.FormatInt(now.Unix(), 10)
	req.Header.Set("X-FUDISLTE-Timestamp", ts)
	req.Header.Set("X-FUDISLTE-Signature", signature(secret, ts, req.Method, req.URL.RequestURI(), body))
}

// Incoming (worker -> API callback): read the body with a size limit, reject a
// timestamp more than 300 s from now, then
//   ok := hmac.Equal([]byte(r.Header.Get("X-FUDISLTE-Signature")),
//                    []byte(signature(secret, ts, r.Method, r.URL.RequestURI(), body)))
```

**Remaining risk:** someone who can already capture traffic on the internal network can
replay an *identical* request (same method, target and body) within the 300-second
window. Changing the method, path or query string invalidates the signature. Approvals
stay single use, so a replayed approval is refused (`409 approval_used`); index writes
are idempotent. Other headers (`Authorization`, the approval headers on callbacks) are not
signed; the API checks the delegated token and the approval against its own records.

## 4. Errors

Same shape as the FUDISLTE API:

```json
{"error": {"code": "validation_failed", "message": "Some fields are invalid.", "fields": {"items.0.id": "Field required"}}}
```

| Status | Code | When |
| --- | --- | --- |
| 401 | `signature_missing`, `timestamp_invalid`, `timestamp_expired`, `signature_invalid` | §3 |
| 413 | `body_too_large` | Body over `FUDISLTE_AI_MAX_BODY_MB` (audio: `FUDISLTE_AI_MAX_AUDIO_MB`) |
| 422 | `validation_failed` | Field errors in `fields` (paths use the camelCase names) |
| 422 | `input_too_large` | More than 64 prompt batches of items in one request |
| 422 | `audio_unreadable` | Empty or undecodable audio |
| 503 | `capability_disabled` | The capability is not configured (message names it: `llm`, `embeddings`, `transcription`) |
| 503 | `model_unavailable` | The Whisper model could not be loaded |
| 502 | `llm_unavailable`, `llm_invalid_output` | The model server failed or did not answer with JSON |
| 404 | `run_not_found` | Unknown or expired agent run |
| 403 | `approval_mismatch` | The hash does not match the pending action |
| 409 | `approval_used`, `approval_not_pending` | Approval reused, or the run is not waiting for that action |
| 429 | `too_many_runs` | `FUDISLTE_AI_MAX_RUNS` active or waiting runs |
| 500 | `internal_error` | Bug; details only in the worker log |

All JSON uses camelCase. Timestamps are RFC 3339; `updatedAt` must carry a zone.

## 5. Endpoints

### 5.1 `GET /healthz` (unsigned)

```json
{"status": "ok", "version": "0.1.0",
 "capabilities": {"llm": true, "embeddings": true, "transcription": false},
 "llm": {"kind": "ollama", "external": false}}
```

`capabilities` reflects configuration plus successful start (the database opened; the
faster-whisper extra is installed). It does not call the model server. `llm.external` is
`true` when the configured model server is outside the private network (§7); the API
should show that to administrators.

### 5.2 Summaries and task suggestions

`POST /v1/summarize`

```json
{"kind": "meeting", "locale": "tr",
 "items": [{"id": "seg-12", "at": "2026-10-30T09:00:12Z", "author": "Dana", "text": "Cuma günü beta çıkıyor, anlaştık mı?"}]}
```

- `kind`: `meeting` (transcript segments) or `channel` (messages); `locale`: `tr` or `en`
  (output language).
- `items`: 1–5000, unique `id` (1–128 characters; message or segment ids the API can
  resolve), optional `at`, `author` (≤ 200), `text` (≤ 20 000).

```json
{"summary": "…",
 "decisions": [{"text": "Beta ships on Friday.", "citations": ["seg-12", "seg-13"]}],
 "actionItems": [{"text": "Update the release notes.", "citations": ["seg-14"], "assigneeHint": "Alex"}],
 "model": "qwen2.5:7b-instruct",
 "dropped": {"decisions": 1, "actionItems": 0}}
```

Guarantees enforced in code (`fudislte_ai/grounded.py`, tested with a fake model that
invents entries):

- every decision and action item has ≥ 1 citation, and every citation is an `id` from the
  request (from the same prompt batch); other citations are removed, entries left without
  citations are dropped and counted in `dropped`;
- `assigneeHint` is kept only if that name is written in a cited item (text or author),
  otherwise `null`;
- the prompt tells the model to state only what the items say, that decisions must be
  explicit, never to make up ids, and that item text is data, not instructions.

The free-text `summary` cannot be checked mechanically; the UI must label it as
AI-generated and show the decisions and action items with links to their citations
(for meetings, the cited segments give the timestamps). Inputs larger than ~24 000
characters are processed in batches; the partial summaries are combined by further model
calls that are told to add nothing.

`POST /v1/suggest-tasks` — `{"orgId", "locale", "items"}` (items as above) →

```json
{"suggestions": [{"title": "Update the release notes", "description": "…", "citations": ["m2"]}],
 "model": "…", "dropped": 2}
```

Same citation rules. The worker never creates anything: the person reviews each
suggestion in FUDISLTE, and creating the task is an ordinary API request by that person.

### 5.3 Index and permission-aware search

`POST /v1/index`

```json
{"orgId": "…", "sourceType": "message", "sourceId": "…", "aclId": "channel:…",
 "title": "", "text": "…", "updatedAt": "2026-10-30T10:00:00Z"}
```

→ `{"status": "indexed", "chunks": 3}` or `{"status": "stale", "chunks": 0}`.

- `sourceType` matches `^[a-z][a-z0-9_.-]{0,63}$`; `orgId`, `sourceId` ≤ 128; `aclId` ≤ 256;
  `title` ≤ 500; `text` ≤ 1 000 000 characters; title or text non-empty.
- The text is split into ~1200-character chunks (150 overlap, paragraph/sentence
  boundaries), each embedded with the title, and the source's previous chunks are
  replaced in one transaction.
- **Stale protection:** if a newer `updatedAt` is already indexed for the source, nothing
  changes (`stale`). Equal timestamps re-index.

`DELETE /v1/index` — `{"orgId", "sourceType", "sourceId"}` deletes one source;
`{"orgId"}` alone deletes the whole workspace. → `{"deleted": <chunks>}`.

`POST /v1/search`

```json
{"orgId": "…", "query": "beta tarihi", "allowedAclIds": ["channel:…", "room:…"], "limit": 10}
```

→ `{"results": [{"sourceType", "sourceId", "chunk", "aclId", "title", "text", "score", "updatedAt"}]}`
ordered by cosine similarity (`score` 1 = identical). `limit` 1–50 (default 10);
`allowedAclIds` up to 20 000 entries; empty → no results.

The filter `org_id = $orgId AND acl_id = ANY($allowedAclIds)` is part of the SQL query
that ranks by vector distance, with pgvector's iterative HNSW scan (`strict_order`), so
the result is "the nearest chunks among those allowed", never "the nearest chunks, then
filtered". A test indexes 40 forbidden chunks closer to the query than one allowed chunk
and asks for one result: it gets the allowed one.

**What the API must do (the worker cannot):** choose a stable ACL id per container
(`channel:<id>`, `room:<id>`, `dm:<conversationId>`, later `doc:<id>`, `project:<id>`), so
membership changes need no re-indexing; compute `allowedAclIds` at query time from current
memberships exactly like message search (joined channels + public channels the person may
join, rooms with an unexpired admission, their own conversations); re-index when content
moves between containers; delete from the index when content is deleted, removed by
retention or when a workspace is deleted.

Tables (created by the worker at start under an advisory lock; `CREATE EXTENSION vector`
needs a superuser, which the Compose overlay's database user is):

```
ai_index_meta (singleton, embed_model, embed_dim, created_at)
ai_chunks     (org_id, source_type, source_id, chunk_no) PRIMARY KEY, acl_id, title, content,
              source_updated_at, indexed_at, embedding vector(N)
              + btree (org_id, acl_id) + hnsw (embedding vector_cosine_ops)
```

Changing the embedding model or dimension is refused at start (vectors from different
models cannot be compared): drop both tables and let the API re-index.

### 5.4 Transcription

`POST /v1/transcribe` — `multipart/form-data` with field `audio` (file) and optional
`language` (`tr`, `en`; empty = detect). Any format FFmpeg/PyAV decodes (WAV, MP3, Ogg/Opus,
WebM, M4A). →

```json
{"language": "tr", "duration": 4.2, "segments": [{"start": 0.0, "end": 2.1, "text": "Merhaba."}]}
```

`start`/`end` are seconds from the beginning of the file. One transcription runs at a time
(others wait); the API should send recordings in segments of at most a few minutes and
set its timeout accordingly. The audio is spooled to `/tmp` (a tmpfs in Compose) for the
request only.

## 6. Agents (Phase 9)

### 6.1 Runs

`POST /v1/agents/runs` → `201` with a run object.

```json
{"orgId": "…", "userId": "…", "agent": "project",
 "goal": "Create tasks for the action items of yesterday's planning meeting",
 "context": {"meetingId": "…"}, "locale": "tr",
 "limits": {"maxSteps": 8, "maxToolCalls": 12, "maxWallSeconds": 120},
 "delegatedToken": "<per-run token issued by the API>"}
```

- `agent`: `research`, `developer`, `project`, `data`, `whiteboard`, `voice`.
- `goal` 1–4000 characters; `context` any JSON object ≤ 32 KiB (data for the model, not
  trusted as instructions); `locale` defaults to `tr`.
- `limits` (ceilings fixed in the worker): `maxSteps` 1–32 (default 8) model calls;
  `maxToolCalls` 0–64 (default 12); `maxWallSeconds` 5–900 (default 120) of active time.
  Time spent waiting for approval does not count.
- `delegatedToken` (16–4096 characters) is used only as `Authorization: Bearer` on tool
  callbacks for this run. It is never logged or returned and is dropped from memory when
  the run ends.

The call returns when the run **completes**, **pauses for approval**, **fails** or hits a
**limit**. Model and tool calls are bounded by the remaining wall time (an approved action
gets at least 10 seconds), so an API HTTP timeout of `maxWallSeconds + 30 s` is enough. If
the API disconnects, the run still proceeds to its next stopping point; `GET` shows the
outcome.

Run object (also returned by `GET /v1/agents/runs/{id}`, approve and reject):

```json
{"id": "uuid", "orgId": "…", "userId": "…", "agent": "project", "goal": "…", "locale": "tr",
 "status": "awaiting_approval",
 "answer": null, "sources": [],
 "pendingApproval": {"actionId": "uuid", "tool": "create_task",
                     "arguments": {"projectId": "p1", "title": "…", "description": "…"},
                     "hash": "64 hex", "reason": "…", "requestedAt": "…"},
 "error": null,
 "usage": {"steps": 2, "toolCalls": 1, "activeSeconds": 3.2},
 "limits": {"maxSteps": 8, "maxToolCalls": 12, "maxWallSeconds": 120},
 "audit": [{"seq": 1, "at": "…", "type": "run_started", "…": "…"}],
 "createdAt": "…", "updatedAt": "…", "expiresAt": "…"}
```

`status`: `running` (only seen by a concurrent `GET`), `awaiting_approval`, `completed`
(`answer` set), `failed` (`error.code`: `llm_unavailable`, `llm_invalid_output`,
`internal_error`) or `limit_exceeded` (`error.code`: `max_steps`, `max_tool_calls`,
`max_wall_time`). `sources` lists only `{sourceType, sourceId}` pairs that appeared in tool
results; sources the model names but never saw are removed.

**Runs live in memory** for `FUDISLTE_AI_RUN_TTL_SECONDS` after their last change (default
24 h) and are lost when the worker restarts. **The API keeps the authoritative record:** it
stores each run object it receives (status, audit, pending approval) in its own database
and audit log; a `404 run_not_found` for a run it still shows as waiting means the run
expired or the worker restarted, and the API marks it failed.

### 6.2 The loop

The model answers each turn with one JSON object: `{"type": "tool", "tool", "arguments",
"reason"}` or `{"type": "final", "answer", "sources"}`. The worker:

1. checks limits, calls the model (bounded by the remaining wall time);
2. refuses tools that are unknown or not available to this agent (`unknown_tool`) and
   arguments that fail the tool's schema (`invalid_arguments`, unknown fields rejected),
   telling the model why;
3. runs **read-only** tools at once through the API callback (§6.4) and feeds the result
   back (truncated to 12 000 characters);
4. for **destructive** tools, stops: `status = awaiting_approval` with the canonical
   arguments and their hash; nothing has been executed;
5. two invalid answers in a row fail the run (`llm_invalid_output`).

There are no shell, file system, code execution or free network tools, and a tool has no
handler in the worker: every tool is a schema plus a `destructive` flag, executed by the
API. The callback URL is fixed configuration; tool arguments cannot change where a request
goes (no URL or path arguments exist; redirects are not followed).

### 6.3 Approvals

`hash = hex(SHA-256(tool + "\n" + canonical_json(arguments)))` where `canonical_json` is
JSON with keys sorted, no whitespace, non-ASCII escaped as lowercase `\uXXXX` (Python
`json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)`). Tool arguments
contain no floating-point numbers. Test vector: tool `post_message`, arguments
`{"text": "Merhaba dünya", "channelId": "c1"}` → canonical
`{"channelId":"c1","text":"Merhaba dünya"}` → hash
`fe1be5daa00e06445f67a142ea8675421abc3c91a6bf2794b9cc0d0ae169f236`.

`POST /v1/agents/runs/{id}/approve` — `{"actionId", "hash", "approvedBy", "delegatedToken"?}`
executes **exactly the stored call, once**, then continues the loop and returns the run
(at its next stopping point). The request cannot carry arguments (unknown fields are
rejected). `delegatedToken` optionally replaces a token that may have expired while
waiting.

`POST /v1/agents/runs/{id}/reject` — `{"actionId", "hash", "rejectedBy", "reason"?}` skips
the action; the model is told a person rejected it and continues or finishes.

Refusals (each recorded as `approval_refused` in the audit): hash differs →
`403 approval_mismatch` (the action stays pending); action already approved or rejected →
`409 approval_used`; run not waiting for that action → `409 approval_not_pending`. The
action id is consumed before the tool runs, so concurrent approvals cannot run it twice.

The API should keep the hash and arguments it received with the pending approval, show
the person the tool and arguments, and send back the stored `actionId` and `hash` — it does
not need to recompute the hash. It must also check it on the callback (§6.4).

### 6.4 Tool callbacks (worker → API)

```
POST {FUDISLTE_AI_API_URL}/internal/ai/tools/{tool}
Authorization: Bearer <delegatedToken>
X-FUDISLTE-Timestamp, X-FUDISLTE-Signature        §3 with the same secret: method POST,
                                              target /internal/ai/tools/{tool}
X-FUDISLTE-Approval-Action, X-FUDISLTE-Approval-Hash   only for an approved destructive tool
Content-Type: application/json

{"runId": "…", "orgId": "…", "userId": "…", "agent": "project",
 "tool": "create_task", "arguments": {"projectId": "p1", "title": "…"}}
```

Success: any 2xx with a JSON body — the result given to the model (≤ 256 KiB; include
`sourceType`/`sourceId` on items that may be cited). Failure: non-2xx with the usual
`{"error": {"code", "message"}}`; the code and message are shown to the model and the
audit (`tool_unavailable` for tools not built yet). Timeout: 30 s or the run's remaining
time (approved actions get at least 10 s). Redirects are not followed.

The API must: verify the signature (only the worker can call); verify the token (issued
for this run, user and workspace, short-lived, valid only on `/internal/ai/tools/*`);
for destructive tools require the approval headers to match a pending approval it
recorded **and a person approved**, with the same tool and arguments (compare decoded JSON
values), and mark it used; run the tool as the person with the normal permission checks;
audit it. `/internal/*` must never be exposed through Caddy (today Caddy proxies only
`/api/*` and `/livekit/*`).

### 6.5 Tools

`GET /v1/agents` returns the catalog (per agent: tool name, description, `destructive`,
JSON schema).

| Tool | Destructive | Arguments | Agents |
| --- | --- | --- | --- |
| `search` | no | `query`, `limit` (1–20, 8) | all |
| `get_item` | no | `sourceType`, `sourceId` | all |
| `list_channel_messages` | no | `channelId`, `limit` (1–200, 50), `before`? | project |
| `list_tasks` | no | `projectId`?, `query`?, `status`?, `limit` | developer, project |
| `list_git_activity` | no | `projectId`?, `limit` (1–100, 30) | developer |
| `query_widget` | no | `widgetId` | data |
| `get_whiteboard` | no | `boardId` | whiteboard |
| `get_meeting` | no | `meetingId` | voice |
| `create_task` | **yes** | `projectId`, `title`, `description`, `assigneeId`?, `dueDate`? | developer, project, voice |
| `update_task` | **yes** | `taskId` + at least one of `title`, `description`, `status`, `assigneeId`, `dueDate` | developer, project |
| `post_message` | **yes** | `channelId`, `text` (≤ 4000), `threadId`? | project, voice |
| `add_whiteboard_elements` | **yes** | `boardId`, `elements` (1–50 of text/sticky/rectangle/ellipse/arrow with integer `x`, `y`, `width`, `height`) | whiteboard |

Tools for features FUDISLTE does not have yet (projects, Git activity, widgets, whiteboards) are part of the contract; until the API
implements one it answers `404 tool_unavailable` and the agent says it could not do it.

### 6.6 Audit entries

Every entry has `seq`, `at`, `type`:

| `type` | Details |
| --- | --- |
| `run_started` | `agent`, `userId`, `goal`, `limits` |
| `model_step` | `step`, `decision` (`tool`, `final`, `invalid`), `tool`, `reason` |
| `tool_refused` | `tool`, `code` (`unknown_tool`, `invalid_arguments`), `message` |
| `approval_requested` | `actionId`, `tool`, `arguments`, `hash`, `reason` |
| `approval_granted` | `actionId`, `tool`, `hash`, `approvedBy` |
| `approval_refused` | `actionId`, `reason` (`hash_mismatch`, `already_used`, `not_pending`), `by` |
| `action_rejected` | `actionId`, `tool`, `rejectedBy`, `reason` |
| `tool_called` | `tool`, `arguments`, `destructive`, `actionId`/`approvedBy` when approved |
| `tool_result` | `tool`, `ok`, `preview` (first 1000 characters) or `error` |
| `limit_reached` | `limit` |
| `run_failed` / `run_completed` | `code`, `message` / `sources` |

## 7. Data handling

| Data | Where | How long |
| --- | --- | --- |
| Items to summarize, texts to embed, agent goals and tool results | Worker memory during the request; sent to the model server | Request |
| Audio | `/tmp` (tmpfs in Compose), then decoded in memory | Request; the file is deleted after |
| Indexed chunks (copies of message/document text) + embeddings + ids + ACL id | `ai-postgres` volume | Until the API deletes them (deletion, retention, workspace deletion) |
| Agent runs (goal, audit with arguments and result previews, pending approval) | Worker memory | TTL (24 h default) or restart |
| Delegated tokens | Worker memory | Until the run ends |

- **Nothing leaves the server unless the configured model URL is external.** The worker
  talks only to `FUDISLTE_AI_LLM_URL`/`FUDISLTE_AI_EMBED_URL`, `FUDISLTE_AI_DATABASE_URL` and
  `FUDISLTE_AI_API_URL`. Whisper runs inside the worker; `HF_HUB_OFFLINE=1` in Compose stops
  any model download. In Compose the worker's networks have no internet route at all.
- A model URL outside the private network (anything but loopback, private addresses,
  single-label service names, `.internal`, `.local`, `.lan`, `.home.arpa`) is refused at
  start unless `FUDISLTE_AI_ALLOW_EXTERNAL_LLM=true`, and then only over `https`;
  `/healthz` reports `"external": true` and the worker logs a warning at start.
- The worker does not log request bodies, prompts, results or tokens (no access log;
  errors are logged by type).
- The vector index is derived data and a copy of content: include `ai-postgres` in
  backups only if desired (it can be rebuilt by re-indexing), and remember that its
  content must follow deletions and retention.
- Model servers have their own logging; check it (for example, do not enable debug
  logging of prompts in production).

## 8. Enabling real backends

None of these were run in this repository (no model was downloaded); the HTTP formats are
tested against mocked servers and, end to end, against a fake Ollama.

**Ollama in the same stack** (MIT; CPU or GPU):

```bash
# .env
FUDISLTE_AI_LLM_KIND=ollama
FUDISLTE_AI_LLM_URL=http://ollama:11434
FUDISLTE_AI_LLM_MODEL=qwen2.5:7b-instruct      # any chat model; check its license
FUDISLTE_AI_EMBED_MODEL=nomic-embed-text        # 768 dimensions
FUDISLTE_AI_EMBED_DIM=768
COMPOSE_PROFILES=ollama                       # or media,ollama

# Pull the models once into the ollama-data volume (this one-off container has internet;
# the Ollama service itself does not):
docker run --rm -v fudislte_ollama-data:/root/.ollama --entrypoint /bin/sh ollama/ollama:0.40.4 \
  -c 'ollama serve >/dev/null 2>&1 & sleep 5; ollama pull qwen2.5:7b-instruct && ollama pull nomic-embed-text'

docker compose -f compose.yml -f compose.ai.yml up -d --build
```

Turkish output quality depends on the model; evaluate a few candidates on real meeting
transcripts before choosing. For an NVIDIA GPU, add the `deploy` block shown in
`compose.ai.yml` and install the NVIDIA container toolkit.

**vLLM on a GPU host** (Apache-2.0, OpenAI-compatible): run one server for the chat model
and one for the embedding model, e.g. `vllm serve <chat-model> --api-key <key>` and
`vllm serve <embedding-model> --port 8001 --api-key <key>`, then

```bash
FUDISLTE_AI_LLM_KIND=openai
FUDISLTE_AI_LLM_URL=http://gpu1.internal:8000/v1
FUDISLTE_AI_EMBED_URL=http://gpu1.internal:8001/v1
FUDISLTE_AI_LLM_API_KEY=<key>
```

The worker's Compose networks have no route out; to reach another host, attach the `ai`
service to an additional (non-internal) network in a further override file.

**External hosted API** (data leaves the server): `FUDISLTE_AI_LLM_KIND=openai`,
`FUDISLTE_AI_LLM_URL=https://…/v1`, `FUDISLTE_AI_LLM_API_KEY`, `FUDISLTE_AI_ALLOW_EXTERNAL_LLM=true`,
plus a network with internet access. Decide this with the data owner; FUDISLTE's default is
local.

**faster-whisper** (MIT): build the image with `FUDISLTE_AI_WITH_WHISPER=true`, put a
CTranslate2 Whisper model into the `ai-models` volume and point the worker at it:

```bash
docker run --rm -v fudislte_ai-models:/models python:3.12-slim sh -c \
  "pip install -q huggingface_hub && python -c \"from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', local_dir='/models/faster-whisper-small')\""
# .env
FUDISLTE_AI_WITH_WHISPER=true
FUDISLTE_AI_WHISPER_MODEL=/models/faster-whisper-small   # or medium / large-v3 for accuracy
FUDISLTE_AI_WHISPER_DEVICE=cpu
FUDISLTE_AI_WHISPER_COMPUTE_TYPE=int8
```

The default image is CPU-only; GPU transcription needs a CUDA base image (not provided).
Speaker diarization (pyannote) is not included: its pretrained pipelines are gated by
separate terms (docs/dependencies.md).

## 9. Deployment (Compose overlay)

`infrastructure/docker/compose.ai.yml` adds:

- `ai` — the worker image (`services/ai/Dockerfile`: `python:3.12-slim`, user 10001,
  bytecode compiled at build time), `read_only`, `cap_drop: [ALL]`,
  `no-new-privileges`, tmpfs `/tmp` (512 MB), volume `ai-models`, health check
  `python -m fudislte_ai healthcheck`, networks `ai` + `ai-backend`, **no published ports**;
- `ai-postgres` — `pgvector/pgvector:0.8.7-pg17`, network `ai-backend` only (the API
  cannot reach it), volume `ai-postgres-data`;
- `ollama` — `ollama/ollama:0.40.4`, profile `ollama`, network `ai-backend` only;
- for `api`: `FUDISLTE_AI_URL=http://ai:8090`, `FUDISLTE_AI_SHARED_SECRET`, network `ai`. The
  API does **not** `depends_on` the worker.

`.env` additions: `FUDISLTE_AI_SHARED_SECRET` and `FUDISLTE_AI_POSTGRES_PASSWORD` (both
`openssl rand -hex 32`), plus the backend settings above. Without a model configured the
worker runs with every capability off.

## 10. Development and verification

```powershell
wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/ai-provision.sh   # once: python3-venv, pgvector
wsl -d Ubuntu-24.04 -- bash scripts/wsl/ai-test.sh                # venv outside the repo, pytest
wsl -d Ubuntu-24.04 -- bash scripts/wsl/ai-docker-check.sh        # compose config, image, smoke, e2e
```

`ai-test.sh` keeps the virtualenv in `~/.cache/fudislte/ai-venv` (outside OneDrive), creates
a throwaway database with pgvector for the retrieval tests and drops it afterwards.
`ai-docker-check.sh` uses only `fudislte-aicheck-*` containers and a temporary env file.

Verified 2026-10-30 on WSL2 Ubuntu 24.04 (Python 3.12.3, PostgreSQL 17 with pgvector
0.8.7, Docker 29.1.3): `ai-test.sh` → **66 passed**; `ai-docker-check.sh` → **all checks
passed** (image `fudislte/ai:dev`, about 240 MB on disk, user 10001).

| Check | What it covers |
| --- | --- |
| `pytest` (66 tests) | Signatures (both vectors, skew, tampering, size limits, exempt healthz; a valid signature replayed with another method, path or query string, with the decoded instead of the raw path, or to another endpoint taking the same body is refused; the old body-only form is refused); configuration (external URL guard); citation enforcement with a fake model that invents entries; batching; ACL-filtered search, cross-workspace isolation, filter inside the query, stale updates, deletes, model change refused — against real PostgreSQL + pgvector; agents: read-only run, approval pause and single execution, tampered/reused approval, rejection, refused tools, limits (steps, tool calls, wall time with a fake clock), TTL, callback signing; transcription with a fake transcriber; Ollama/OpenAI wire formats against mocked HTTP |
| Mutation check | Removing the SQL ACL filter, the org filter, the citation check, the hash comparison, single use, or the approval pause each makes tests fail; so does leaving the method, the target or the query string out of the signature, using the decoded path, or signing callbacks without their target |
| `ai-docker-check.sh` | Overlay passes `docker compose config` (no published worker ports, internal networks, API not dependent on the worker, missing secret refused); image builds; the read-only, unprivileged container answers `/healthz`; openssl-signed requests (including a query string) are accepted; unsigned, stale and replayed-elsewhere requests (other path, method or query) are refused; end to end with the `pgvector/pgvector:0.8.7-pg17` image and a fake Ollama: index, ACL-filtered search, cross-workspace isolation, invented decision dropped, workspace delete |

## 11. Limitations and open points

- Not run against a real model: prompt quality, Turkish output and JSON compliance of
  specific models are unmeasured. Whisper, Ollama and vLLM paths were not executed.
- Runs are in memory: one worker instance; a restart loses runs (the API's record stays).
  Several replicas need a shared run store or sticky routing.
- An identical request (same method, target and body) can be replayed within 300 seconds
  by someone able to capture traffic on the internal network (§3). Approvals stay single
  use.
- Prompt injection through messages, documents or tool results can still mislead the
  model's text. Mitigations: citations enforced, read-only tools only see what the person
  can see, destructive actions need approval of the exact call, no exfiltration path
  (no network tools; local model; internal networks).
- The summary text itself is not machine-checked; only decisions, action items and
  suggestions are.
- The Go side (client, indexing hooks, ACL ids, approvals UI, tool callbacks, run records)
  is not built yet.

## 12. Dependencies

Runtime (`services/ai/requirements.lock`, resolved 2026-10-30; licenses from each package's
metadata):

| Package | Version | License | Why |
| --- | --- | --- | --- |
| fastapi | 0.162.0 | MIT | HTTP framework |
| starlette | 1.10.0 | BSD-3-Clause | FastAPI's toolkit |
| uvicorn (no extras) | 0.54.0 | BSD-3-Clause | ASGI server |
| h11 | 0.16.0 | MIT | uvicorn HTTP/1.1 |
| click | 8.5.0 | BSD-3-Clause | uvicorn dependency |
| pydantic / pydantic_core | 2.14.2 / 2.50.2 | MIT | Validation |
| annotated-types, typing-inspection, annotated-doc | 0.8.0, 0.4.4, 0.0.5 | MIT | pydantic / FastAPI dependencies |
| typing_extensions | 4.16.0 | **PSF-2.0** (permissive, not in the preferred list) | pydantic dependency |
| opentelemetry-api | 1.45.2 | Apache-2.0 | FastAPI dependency (not used by the worker) |
| anyio | 4.15.1 | MIT | Async runtime |
| httpx / httpcore | 0.28.1 / 1.0.9 | BSD-3-Clause | Model server and API calls |
| idna | 3.20 | BSD-3-Clause | httpx dependency |
| certifi | 2026.10.23 | **MPL-2.0** (file-level copyleft; used unmodified) | httpx CA bundle |
| asyncpg | 0.32.0 | Apache-2.0 | PostgreSQL driver |
| python-multipart | 0.0.32 | Apache-2.0 | Multipart parsing for `/v1/transcribe` |

Tests only (`requirements-dev.lock`): pytest 9.2.0 (MIT), pluggy 1.7.0 (MIT), iniconfig
2.3.1 (MIT), packaging 26.3 (Apache-2.0 OR BSD-2-Clause), Pygments 2.21.0 (BSD-2-Clause).

Optional `whisper` extra (not installed by default, not verified here): faster-whisper
1.2.1 (MIT) with ctranslate2 4.8.4 (MIT), onnxruntime 1.31.1 (MIT), tokenizers 0.23.3
(Apache-2.0), huggingface-hub 2.4.0 (Apache-2.0), numpy (BSD-3-Clause and other
permissive), PyYAML (MIT), **tqdm (MPL-2.0 AND MIT)** and **av 19.0.2 (PyAV: BSD-3-Clause,
but its wheels bundle FFmpeg libraries under LGPL-2.1+; review before distributing an image
built with `WITH_WHISPER=true`)**. Model weights carry their own licenses (Whisper: MIT).

Images: `python:3.12-slim` (Python: PSF-2.0; Debian packages under their own licenses),
`pgvector/pgvector:0.8.7-pg17` (PostgreSQL License for both), `ollama/ollama:0.40.4` (MIT).

## 13. Go integration checklist (API side)

1. **Configuration.** `FUDISLTE_AI_URL` (empty = AI off: no AI UI, no calls) and
   `FUDISLTE_AI_SHARED_SECRET` (≥ 32 characters, the worker's value). Refuse to start with a
   URL and a missing or short secret.
2. **Signing (§3).** Build the request first, then sign `timestamp + "." +
   strings.ToUpper(req.Method) + "." + req.URL.RequestURI() + "." + body` over the exact
   body bytes sent; a new timestamp for every attempt. Check your implementation against
   both worked examples in §3, e.g. the string
   `1767225600.POST./v1/summarize.{"hello":"world"}` with secret
   `0123456789abcdef0123456789abcdef` must give
   `v1=285f6e5651d72488cf206fc8c15018852981cc64e4fc6400cfffecde0a121c1e`.
3. **HTTP client.** No redirects (`CheckRedirect` returns `http.ErrUseLastResponse`).
   Timeouts: `/healthz` 5 s, search 30 s, index 60 s, summaries and suggestions several
   minutes (one model call per ~24 000 characters of items), transcription several minutes
   per segment, agent calls `maxWallSeconds + 30 s`.
4. **Capabilities.** Poll `GET /healthz` (unsigned) every 30–60 s and cache it; expose the
   capabilities to the web app; treat connection errors, 5xx and `503 capability_disabled`
   as "AI unavailable" without affecting anything else. Show administrators
   `llm.external`.
5. **ACL ids.** One stable id per container: `channel:<id>`, `room:<id>`,
   `dm:<conversationId>`, later `doc:<id>`, `project:<id>`. Membership changes then need no
   re-indexing.
6. **Indexing hooks** (after commit, through a queue or outbox so no user request waits for
   the worker; retry with backoff — the stale check makes out-of-order delivery safe):
   message created or edited → `POST /v1/index` (`updatedAt` = last edit); message deleted
   or removed by retention → `DELETE /v1/index`; channel or room deleted → delete its
   sources; workspace deleted → `DELETE /v1/index {"orgId"}`; content moved to another
   container → re-index with the new `aclId`; a backfill job when AI is enabled.
7. **Search.** `orgId` from the route the person is authorized for, never from the client
   body; `allowedAclIds` computed at request time with the message-search rules (joined
   channels and public channels they may join, rooms with an unexpired admission, their
   own conversations). Resolve each hit to the live object and drop what no longer
   resolves (deleted after indexing).
8. **Summaries.** Send message or transcript-segment ids as item ids; show citations as
   links (messages) or timestamps (segments); label the result as AI-generated and keep it
   as an AI artifact with `model` and `dropped`, never as the people's own decision record.
9. **Task suggestions.** Show as suggestions only; creating a task is the person's ordinary
   API request, audited as theirs.
10. **Agents.**
    - A permission for running agents (e.g. `ai.agents.run`), checked before starting.
    - Delegated token per run: random, stored hashed, bound to run, person and workspace,
      short-lived (renew it with `delegatedToken` on approve), valid only on
      `/internal/ai/tools/*`, revoked when the run ends.
    - Store every run object the worker returns (status, `audit`, `pendingApproval`): the
      API's copy is the authoritative record; mirror the audit into the workspace audit log.
    - Approval UI shows tool, arguments and reason; approve or reject sends the stored
      `actionId` and `hash` with the deciding person (`approvedBy` / `rejectedBy`). Decide who
      may approve (at least: the run's owner).
    - `POST /internal/ai/tools/{tool}`: served for the worker only — Caddy proxies `/api/*`
      and `/livekit/*`, never `/internal/*`. Verify the signature (method `POST`, target
      `r.URL.RequestURI()`, the exact body read with a size limit, ±300 s); verify the token
      and that `runId`, `orgId` and `userId` in the body match it; for destructive tools
      require `X-FUDISLTE-Approval-Action`/`X-FUDISLTE-Approval-Hash` to match a recorded,
      human-approved, unused approval of this run with the same tool and arguments (compare
      decoded JSON values), then mark it used; run the tool as the person with the normal
      permission checks; answer JSON, or `{"error": {...}}` (`404 tool_unavailable` for tools
      not built yet).
    - A `404 run_not_found` for a run the API still shows as running or waiting means the
      worker restarted or the run expired: mark it failed.
11. **Transcription.** Split recordings into segments of a few minutes, send them as
    multipart (`audio`, `language`), store the segments with their offsets, and pass
    segment ids as items to `/v1/summarize`.
12. **Tests on the API side.** Both signature vectors; a request signed for one path or
    method is refused by the callback handler; AI disabled → core flows unchanged and AI
    endpoints absent; losing access removes the ACL id from `allowedAclIds`; callbacks for
    destructive tools refused without, or with a mismatching, approval.
