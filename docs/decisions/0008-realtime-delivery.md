# ADR-0008: Real-time delivery from the API process (Server-Sent Events)

Status: Accepted · Phase 2

## Context
Messaging needs live updates: new, edited and deleted messages, unread counts, later
typing and presence. The roadmap planned Centrifugo plus Redis for this. Most FUDISLTE
installations are a single API node serving one organization (tens to a few thousand
people), installed by an IT team that wants as few services as possible.

The security requirement is strict: a member removed from a channel or workspace, or
whose session is revoked, must stop receiving events immediately.

## Decision
- The API serves one authenticated event stream per browser tab:
  `GET /api/v1/events` (Server-Sent Events, session cookie, same origin).
- Each stream belongs to one user and one session. Events are addressed to users, never
  to channel topics: for every change the API computes the recipients from the database
  *at publish time* (current channel members) and hands the event to an in-process hub.
  Removing a member therefore stops delivery without any unsubscribe step.
- Logging out or revoking a session closes that session's streams at once.
- Events are published only after the transaction commits. They are notifications, not
  the source of truth: after a reconnect the client refetches what it shows.
- A slow client whose buffer fills is disconnected (it reconnects and refetches) so one
  stalled connection cannot hold memory or block publishers.
- Writes go through the normal REST API (CSRF-protected); the stream is read-only.
- The hub sits behind a small `Publish(userIDs, event)` interface. When a deployment
  needs several API replicas, a shared transport (Centrifugo or PostgreSQL
  LISTEN/NOTIFY) replaces the in-process hub without changing the API or the client
  contract.

## Consequences
- No extra service for Phase 2 chat: Docker Compose stays Caddy + API + PostgreSQL.
- SSE needs no client library and passes through Caddy and the Vite proxy unchanged;
  browsers reconnect automatically.
- Single-node only until the shared transport lands (Phase 10 load tests decide when).
- The API's write timeout does not apply to streams (they extend their own deadlines and
  send a heartbeat every 25 seconds).
