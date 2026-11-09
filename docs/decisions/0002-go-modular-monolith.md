# ADR-0002: Go modular monolith (chi, pgx, goose)

Status: Accepted · Phase 1

## Context
Self-hosters run FUDISLTE on a single VPS or a small cluster. Operational simplicity
outweighs independent scaling of modules at this stage.

## Decision
- One Go binary (`fudislte-api`) with modules under `internal/<module>`; modules talk
  through Go interfaces, not the network.
- `go-chi/chi` router: standard `net/http` handlers, small, MIT.
- `jackc/pgx/v5` for PostgreSQL with hand-written SQL. Queries stay next to the module
  that owns the tables. `sqlc` can be adopted later without changing the schema.
- `pressly/goose/v3` migrations embedded in the binary, applied at startup under a
  PostgreSQL session lock (safe with several API replicas) or via `fudislte-api migrate`.
- UUIDv7 primary keys generated in Go (time-ordered, index-friendly).
- `log/slog` structured logging, JSON in production.

## Consequences
A single deployable with transactional consistency across modules. Splitting a module
out later (for example the AI worker, which is Python) happens over an explicit API.
