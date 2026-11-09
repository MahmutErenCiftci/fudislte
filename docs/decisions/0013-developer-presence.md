# ADR-0013: Developer presence from VS Code is opt-in, coarse and token-scoped

Status: Accepted · Phase 6

## Context
Phase 6 adds a VS Code extension that shows teammates when someone is coding. An editor
extension can see everything — files, keystrokes, repositories, working hours — so this
is exactly where "no hidden monitoring" must hold: developer presence is opt-in and never
includes code, keystrokes, file names or paths. FUDISLTE already has a person-chosen
status (kind, text, expiry, mute; phase-2.md, increment 2.4) that is shown only to
people who may view the member directory. Browser and desktop clients authenticate with
server-side session cookies (ADR-0004), which an editor extension should not hold.

## Decision
- **Reuse the status, add no activity data.** The extension sets the existing status to
  kind `coding` with a short text and clears it again; the server stores nothing new —
  no activity log, no timeline, no durations. People see "Coding · VS Code", as if the
  person had set it.
- **Opt-in at every level.** Sharing is off by default. The text is `VS Code`; the
  workspace folder name and the editor's language are separate opt-ins, both off. All
  settings are user-level only (`application` scope), so a repository cannot opt anyone
  in or redirect the token. Turning sharing off or disconnecting clears the status at
  once.
- **Coarse by construction.** Editor events only mark that the person is active; their
  data is never read. A folder name that looks like a path is dropped, not shortened.
  Commit-message and other non-code editors never name a language. No telemetry.
- **Self-expiring, rarely refreshed.** Each status expires after 15 minutes and is
  refreshed at most every 5 minutes while the person is active; it is cleared after an
  idle time (default 10 minutes) and when VS Code closes. A crash leaves at most
  15 minutes of "coding". Per active VS Code window the server sees one read and one
  write when work starts or stops and at most one pair every 5 minutes in between.
- **The person's own status wins.** The extension remembers exactly what it set and
  changes or clears only that; a status the person set in FUDISLTE is left alone until it
  ends.
- **Personal access tokens, not sessions.** The extension authenticates with
  `Authorization: Bearer fdp_<token>` carrying the scope `status:write`. Tokens are
  created and revoked by the person, stored hashed (SHA-256, like sessions), and limited
  by default-deny scopes: `GET /api/v1/me` for any valid token, `PUT`/`DELETE
  /api/v1/me/status` for `status:write`, nothing else. In VS Code the token lives only
  in SecretStorage, bound to the server origin it was entered for; plain HTTP is allowed
  only for localhost, and redirects are never followed.
- **Shipped as a `.vsix`** built from `extensions/vscode` with esbuild and `vsce`,
  outside the pnpm workspace, with no runtime dependencies and no source maps.

## Consequences
- The API must add personal access tokens (issue, list, revoke, scopes, audit) before
  the extension can work; until then every authenticated call is refused with 401.
- Presence is deliberately coarse: nobody can see which file, which repository (unless
  opted in) or for how long someone worked. Administrators cannot turn it on for anyone.
- Clearing reads the status before deleting it; a status set in that instant could be
  cleared. A conditional delete in the API (`If-Match` on a status version) would remove
  the race.
- Several VS Code windows coordinate through VS Code's global state, best effort: any
  window may refresh, only the window that set the latest status clears it.
- The same contract (status endpoints plus a `status:write` token) serves other editors
  later without server changes.
