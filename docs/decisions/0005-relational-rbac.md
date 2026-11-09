# ADR-0005: Relational RBAC instead of Casbin (for now)

Status: Accepted · Phase 1 · Revisit in Phase 3

## Context
Phase 1 needs organization roles with a fixed permission catalog. Phases 2–3 add
resource grants (private channels, restricted rooms) where the most frequent question is
"which channels can this user see?" — a filtered list query.

## Options
- **Casbin (Apache-2.0)**: flexible policy models and adapters. Answers "may X do Y on Z"
  well, but cannot push a filter into a SQL query, so listing visible resources means
  loading all policies or all resources.
- **Relational model**: roles and grants are tables; checks and listings are SQL joins
  inside the same transaction as the business change.

## Decision
Relational RBAC: `roles.permissions text[]` checked against a Go permission catalog,
role `position` for hierarchy, and (Phase 2+) explicit `*_grants` tables per resource
type. All checks live in the Go service layer behind small functions so a policy engine
could replace them without touching handlers.

## Consequences
Policies are not editable as text files. Fine-grained conditions (time windows, device
posture) would need code — acceptable until a customer requires ABAC.
