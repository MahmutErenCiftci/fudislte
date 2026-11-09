# ADR-0001: Monorepo with pnpm workspaces and a Go module

Status: Accepted · Phase 1

## Context
Web, desktop and future IDE-extension clients must share components, API types and
business logic. The backend is Go. Developer setup has to stay simple.

## Decision
- One repository. pnpm workspaces for TypeScript (`apps/*`, `packages/*`), a single Go
  module in `services/api`.
- Internal TypeScript packages are consumed as source (`exports` → `src/*.ts`); Vite
  compiles them. No per-package build step until a package is published.
- TypeScript 6.0 (the last JavaScript-implemented compiler) for type checking. TypeScript
  7 (native) is re-evaluated once its toolchain is signed and stable on locked-down
  Windows machines.
- Vite 8, React 19, Tailwind CSS 4, TanStack Query 5, React Router 7, Vitest 5.
- No Turborepo/Nx yet: workspace scripts run with `pnpm -r`. Revisit when CI time matters.

## Consequences
One `pnpm install` sets up every client. Packages cannot accidentally diverge on React
versions. Build caching across packages is not available yet.
