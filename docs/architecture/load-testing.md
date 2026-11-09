# Load testing

How the API behaves with many people online in one busy channel: message posting
latency, live delivery to every member over Server-Sent Events
([ADR-0008](../decisions/0008-realtime-delivery.md)), throughput, errors and dropped
events. Measured on 2026-10-30 on a developer laptop; read the [caveats](#caveats) before
using the numbers for sizing.

## Summary

- **At the sizes the roadmap targets first — 50 and 200 people online — the API is nearly
  idle.** With everyone in one channel and 10–20 messages per second, the 99th-percentile
  post latency and end-to-end delivery latency stayed under 10 ms, with no errors and no
  dropped events; the API used 0.05–0.17 CPU cores and 43 MiB of memory.
- **No event was dropped in any run**: up to 1,000 open event streams, about 200,000
  delivered events per second, and 1,000 clients connecting at the same instant.
- **The first signs of saturation** appeared at 1,000 streams and 200 messages per second
  (≈200,000 events/s): p99 37 ms, worst case 382 ms, API at 4 CPU cores — on a machine that
  also ran the load generator (3.6 cores).
- **Fan-out costs roughly 20–30 µs of API CPU per delivered event**, about one core per
  40,000 events per second.
- **Presence grows quadratically**: every stream that opens notifies every member, so n
  people connecting produce about n²/2 presence events (500,000 for 1,000 people; nearly
  1,000,000 when they all reconnect at once). Harmless at these sizes; a scaling risk for
  large deployments (see [follow-ups](#follow-ups)).

## What is measured

One workspace, all test members in its default channel, which is the worst case for
fan-out: every message goes to every member.

- **Streams**: N members each keep one live event stream open (`GET /api/v1/events`), as
  the web app does; N is the "users" of a scenario. Streams open evenly over 5 s (or all at
  once in the burst run), and the test waits until each one has received its `ready` event.
- **Posts**: P of these members post messages to the channel (`POST
  …/channels/{id}/messages`), R messages per second in total, on a fixed schedule for 60 s.
  The schedule is open-loop: a slow response does not delay the next message, so queueing
  shows up in the latencies instead of hiding. Each poster sends at most 2 messages per
  second, below the API's per-person limit of 5 per second (burst 20).
- **Post latency**: from just before the request is sent until the `201` response is read.
- **Delivery latency**: from just before the POST is sent until another member's stream
  has parsed the `message.created` event. Sender and receivers are in the same process, so
  one monotonic clock measures both ends. The author's own copy is excluded.
- **Time to last recipient**: per message, the delivery latency of the slowest member.
- **Dropped events**: accepted messages × (N − 1) other members, minus the events received.
  Duplicates are counted separately (a per-stream bitset). Streams that the server closes
  — the hub closes a stream whose 64-event buffer is full — are counted and reconnect after
  3 s like a browser; events missed meanwhile count as dropped.
- **Resources**, from `/proc` over the posting window: CPU time of the API process, its
  peak resident memory, CPU of all `postgres` processes on the host, of the load generator
  itself, and the host's busy share.

## Tooling

- **`tools/loadtest`** — a separate Go module, standard library only:
  `setup-code` / `setup` (first-run setup through the API), `seed-sql` (members and
  sessions as SQL), `populate` (realistic content, used by the restore drills) and `run`
  (the measurement above). `go test` covers the event-stream parser and the statistics.
- **`scripts/ops/loadtest.sh`** — a throwaway environment that never touches the
  development database. Per scenario it creates database `fudislte_load`, builds the API from
  `services/api` the way the Dockerfile does (`CGO_ENABLED=0 go build -trimpath -ldflags
  "-s -w"`, into `/tmp`), starts it on `127.0.0.1:8091` with only these settings
  (`FUDISLTE_ENV=development`, `FUDISLTE_MAIL_TRANSPORT=log`, `FUDISLTE_DATABASE_URL` →
  `fudislte_load`, `FUDISLTE_DATA_DIR` under `/tmp`, `FUDISLTE_PUBLIC_URL=http://localhost:8091`,
  `FUDISLTE_COOKIE_SECURE=false`, JSON logs at info level), completes first-run setup through
  the API (`POST /api/v1/setup/code`, the code read from the API log, `POST /api/v1/setup`),
  adds the members in SQL, runs the test, then stops the API and drops the database.

Members are created directly in SQL because signing in 1,000 people through email codes
would take longer than the test and is rate-limited by design. The rows are the ones the
API writes: `users`, `memberships` with the Employee role — the default-channel trigger
then joins each member to the channel — and one `sessions` row each, storing SHA-256 of a
random 256-bit token exactly like `internal/auth`; the test sends the token as the
`fudislte_session` cookie.

```bash
wsl -d Ubuntu-24.04 -- bash scripts/ops/loadtest.sh                       # 50:10:10, 200:20:20, 200:50:100
wsl -d Ubuntu-24.04 -- bash scripts/ops/loadtest.sh --scenario 1000:50:50 --ramp 0s --duration 30s
```

`--scenario USERS:POSTERS:RATE` is repeatable; results are written to
`/tmp/fudislte-loadtest-results` as text and JSON.

## Environment

| | |
| --- | --- |
| Machine | Laptop, AMD Ryzen 7 7840HS (8 cores / 16 threads), 15.3 GiB RAM, Windows 11 Home 10.0.26200, **running on battery** ("High performance" power plan) |
| Virtualization | WSL 3.0.3.0, kernel 6.18.54.1-microsoft-standard-WSL2; the Ubuntu 24.04 VM sees 16 logical CPUs, 7.4 GiB RAM, 2 GiB swap |
| API | built from the working tree on 2026-10-30 (schema version 11), Go 1.27.3, static binary, development mode (plain HTTP, log mail transport) |
| Database | PostgreSQL 17.11 (Ubuntu PGDG package) in the same VM, default settings (`shared_buffers` 128 MB, `max_connections` 100); API pool: 16 connections (pgx default) |
| Load generator | `tools/loadtest run` in the same VM, connecting to `127.0.0.1:8091` directly — no Caddy, no TLS, no network |
| Also running | the development API, Vite, a LiveKit container and the idle `fudislte-local` Compose stack |

## Results

60-second posting windows; message bodies about 120 bytes; latencies in milliseconds
(p50 / p95 / p99 / max).

| Scenario | Streams | Posters | Messages/s | Accepted | Post latency | Delivered (expected) | Dropped | Delivery latency | Last recipient | Events/s | API CPU cores | API peak RSS | Host CPU |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| **50 users** | 50 | 10 | 10 | 600 / 600 | 7.1 / 8.0 / 9.2 / 21.8 | 29,400 (29,400) | 0 | 7.0 / 8.0 / 9.1 / 21.7 | 7.2 / 8.2 / 9.4 / 21.7 | 491 | 0.05 | 43 MiB | 1% |
| **200 users** | 200 | 20 | 20 | 1,200 / 1,200 | 7.1 / 8.3 / 8.9 / 20.1 | 238,800 (238,800) | 0 | 7.0 / 8.2 / 8.8 / 20.0 | 7.3 / 8.5 / 8.9 / 20.0 | 3,983 | 0.17 | 43 MiB | 3% |
| 200 users, busy | 200 | 50 | 100 | 6,000 / 6,000 | 6.1 / 7.5 / 8.3 / 48.2 | 1,194,000 (1,194,000) | 0 | 6.1 / 7.5 / 8.2 / 48.4 | 6.3 / 7.7 / 8.5 / 48.4 | 19,901 | 0.63 | 40 MiB | 11% |
| 500 users | 500 | 50 | 50 | 3,000 / 3,000 | 6.8 / 8.9 / 9.5 / 21.9 | 1,497,000 (1,497,000) | 0 | 6.8 / 8.7 / 9.4 / 23.1 | 7.2 / 9.2 / 9.9 / 23.1 | 24,956 | 0.66 | 60 MiB | 11% |
| 1,000 users | 1,000 | 50 | 50 | 3,000 / 3,000 | 7.1 / 8.6 / 9.5 / 13.3 | 2,997,000 (2,997,000) | 0 | 7.0 / 8.5 / 9.4 / 19.9 | 7.8 / 9.1 / 10.3 / 19.9 | 49,957 | 1.00 | 95 MiB | 17% |
| 1,000 users, busy | 1,000 | 100 | 200 | 12,000 / 12,000 | 8.4 / 15.7 / 37.6 / 370.6 | 11,988,000 (11,988,000) | 0 | 8.2 / 15.6 / 37.2 / 381.8 | 9.1 / 17.7 / 44.6 / 381.8 | 199,789 | 3.96 | 101 MiB | 52% |
| 1,000 users, burst¹ | 1,000 | 50 | 50 | 1,500 / 1,500 | 6.9 / 9.0 / 13.2 / 41.4 | 1,498,500 (1,498,500) | 0 | 6.8 / 9.0 / 13.9 / 54.5 | 7.6 / 10.0 / 17.3 / 54.5 | 49,971 | 1.02 | 96 MiB | 18% |

¹ All 1,000 streams opened at the same instant (`--ramp 0s`), as when every client
reconnects after an API restart; 30-second posting window.

Every run: no HTTP errors, no stream disconnects, reconnects or connection errors, no
duplicates; every accepted message reached every other member; the API logged no errors.

A shorter independent re-run of the 200-user scenario (30 s, schema version 13 with the
Phase 5 tables) gave the same picture: 600 of 600 messages accepted, 119,400 of 119,400
events delivered, p99 post latency 7.8 ms and delivery latency 7.6 ms, API 0.13 cores and
50 MiB.
Load generator CPU: 0.04, 0.14, 0.55, 0.55, 0.91, 3.58 and 0.93 cores; all PostgreSQL
processes together 0.03–0.64 cores.

Opening the streams: the median stream was ready (`ready` event received) 1–2 ms after
its request, the slowest of 1,000 within 32 ms (53 ms in the busy run). In the burst run
all 1,000 were ready 0.16 s after the start (median 93 ms, slowest 134 ms).

Presence events received while the streams opened: 1,275 for 50 members, 20,100 for 200,
125,254 for 500, 500,615 for 1,000 (≈ n(n+1)/2) and 967,182 in the 1,000-client burst,
where nearly every change reaches nearly every stream.

## Observations

1. **Latency is per-message work, not fan-out.** Post latency stays at 6–8 ms whether 50 or
   1,000 members receive the message and at 10 or 100 messages per second; the slowest
   recipient trails the median by under 1 ms up to 1,000 members. The floor is the request
   itself: session and membership lookups, the channel query, the insert transaction
   (message, mentions, notifications, read marker), reloading and enriching the message and
   listing the members to notify — roughly 15 database statements and one commit.
2. **Members see a message as soon as its author does.** Delivery latency equals post
   latency because the API publishes the event before it writes the HTTP response.
3. **Fan-out CPU is linear in delivered events**: 0.63 cores at 20,000 events/s, 1.0 at
   50,000, 3.96 at 200,000 — 20–30 µs per event. Each event is encoded once per message, but
   written and flushed separately on every stream.
4. **The single-process hub held up**: with 1,000 streams the whole API process peaked at
   about 100 MiB, and the 64-event per-stream buffer never overflowed — with fast local
   readers (see caveats).
5. **The busy 1,000-user run is where tails grow** (p99 37 ms, max 382 ms) while the host was
   52% busy and the load generator competed with the API for CPU. The numbers do not say
   which side queued; a load generator on a separate machine would.
6. **Presence is the one quadratic cost.** A full reconnect of 1,000 people produced nearly
   a million presence events in a fraction of a second without loss here; at 5,000 people
   it would be about 12.5 million, all at once after a restart.

## Caveats

- **One machine.** API, PostgreSQL and the load generator shared one WSL2 VM on a laptop
  running on battery, beside other development processes. Real deployments add Caddy, TLS,
  network round trips and real browsers; the load generator here competed for the same CPUs.
- **WSL2 and development configuration.** Virtualized disk and CPU; PostgreSQL with
  default settings; the API in development mode (plain HTTP, log mail transport — neither
  is on the measured path). The binary was built like the production image, from the
  working tree of the day (schema version 11), not from a release.
- **One traffic pattern.** One channel with everyone in it, short text messages only. Not
  measured: threads, mentions and notifications at scale, reactions, file uploads and
  downloads, search, typing indicators, presence reports, many channels, direct messages,
  the read paths that clients call after (re)connecting (channel and message lists,
  unread counts), sign-in, and voice/video.
- **Fast, well-behaved clients.** All readers were local Go programs that never fell
  behind. Slow consumers (mobile networks, sleeping laptops) — the case where the hub
  closes a stream with a full buffer — were not simulated.
- **Short runs and a small database.** 60-second windows on a fresh database of at most
  12,000 messages; no soak test, so memory growth over hours and the 30-minute stream
  recycling were not exercised.
- **One API process.** The real-time hub is in-process by design; several API replicas
  need a shared event bus (roadmap, Phase 2 notes) and were not tested.

## Follow-ups

- Repeat the 200- and 1,000-user scenarios with the load generator on a separate machine
  and Caddy with TLS in the path, against a deployment sized like the
  [Small/Medium profiles](../deployment/docker-compose.md#deployment-profiles).
- Add slow-consumer and soak scenarios (hours) and a mixed workload (threads, mentions,
  uploads, reconnect-and-refetch).
- Reduce presence fan-out before large deployments. Done: changes that queue up during a
  burst are merged (one state per person, two database queries per batch instead of two
  per change). Still open: send them only to clients that show the member list, or as
  one batched event per client; the event count is still about n²/2.
- Keep `scripts/ops/loadtest.sh` runs as a regression check before releases; compare the
  JSON results with this baseline.
