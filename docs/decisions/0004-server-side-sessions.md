# ADR-0004: Server-side sessions in HttpOnly cookies

Status: Accepted · Phase 1 · Sessions are created by email-code sign-in (ADR-0006)

## Context
Both clients run the same web app on the server's origin (ADR-0003). Sessions must be
revocable immediately (offboarding, password change, stolen device).

## Decision
- Opaque 256-bit random tokens; the database stores only SHA-256(token).
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` and `__Host-` prefix whenever
  served over HTTPS (`FUDISLTE_COOKIE_SECURE=true`, the default).
- 30-day absolute, 7-day idle expiry; `last_seen_at` throttled to one write per 5 min.
- CSRF defence: `http.CrossOriginProtection` (Fetch Metadata + Origin) on all API routes.
- No JWTs: revocation would require a deny-list anyway, and tokens in JavaScript are
  exposed to XSS.
- Non-browser clients (IDE extension, Phase 6) will get separate, scoped personal access
  tokens rather than reusing browser sessions.

## Consequences
One indexed lookup per request (cheap at this scale; cacheable in Redis later).
Revocation is immediate.
