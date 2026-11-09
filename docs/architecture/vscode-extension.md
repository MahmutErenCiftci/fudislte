# VS Code Presence Extension (Phase 6)

Status: **Client done and tested; waits for personal access tokens in the API.** Until
the API accepts `Authorization: Bearer fdp_…`, every authenticated call answers 401 (see
"Verification").

*FUDISLTE Presence* (`extensions/vscode`) shows a person's FUDISLTE status as **Coding**
while they actively work in VS Code. It writes the status that already exists (Phase 2,
increment 2.4); there is no new activity data on the server. It is off until the person
turns it on and shares only the fields they choose. Decisions: ADR-0013.

## 1. What is shared, and what never is

| Field | Sent | Example |
| --- | --- | --- |
| Status kind | Always (while sharing is on) | `coding` |
| Status text | Always `VS Code`; the parts below only when opted in | `VS Code` |
| Workspace folder name | Only with `fudislte.presence.shareProject` | `VS Code · fudislte-api` |
| Language of the active editor | Only with `fudislte.presence.shareLanguage` | `VS Code · fudislte-api · TypeScript` |
| Expiry | Always: now + 15 minutes (server clock) | `2026-10-30T12:15:00Z` |
| Mute | Always `false` | |

**Never sent:** file names, paths, file contents, keystrokes or counts of anything, git
data (branches, commits, remotes, commit messages), how long someone worked, machine or
OS details. There is no telemetry. Editor events are used only as the signal *that*
someone is working; the event data (documents, changes, selections) is not read.

Rules for the text (`src/statusText.ts`):

- The folder is the workspace folder of the active editor, or the first folder. Its name
  is read only when `shareProject` is on.
- A folder name that looks like a path is **dropped entirely**, not shortened, so
  `C:\Users\dana\secret` cannot leak `dana` or `secret`: any `/` or `\` (and look-alike
  slashes), `:` (drive letters, URL schemes, `host:path`), `%2F`/`%5C`/`%3A`, `@`,
  a leading `~`, and `.`/`..`. Control and invisible characters (including bidi
  overrides) are removed, whitespace collapsed, names cut to 40 characters.
- Languages are VS Code language ids: common ones get a display name (`typescript` →
  `TypeScript`), other ids are passed on only if they are short identifiers. Commit
  message and rebase editors (`git-commit`, `git-rebase`), the SCM input, search
  results and logs are never named; neither are editors that are not files
  (output, diff and settings views).
- The text is at most 100 code points (the API's limit) and already in the form the API
  normalizes to, so the extension can recognise exactly what it set.

## 2. Behaviour

- **Activity** counts only in the focused window: changing the active editor, moving the
  cursor or selection, scrolling, editing the active document, focusing or interacting
  with the window (`WindowState.active`). Background changes (git, formatters, other
  tools editing files) therefore never keep someone "coding".
- **Set:** the first activity after being idle reads `GET /api/v1/me`, then sends
  `PUT /api/v1/me/status`, unless a status the person set is shown (below).
- **Refresh:** while the person is active (activity within the idle time), at most every
  5 minutes. Each status expires by itself after 15 minutes, so a crashed or
  disconnected editor never leaves "coding" behind for long.
- **Clear:** after `fudislte.presence.idleMinutes` (default 10) without activity, and when
  the window closes or the extension stops (bounded to about 3 seconds), the extension
  reads `GET /api/v1/me` and sends `DELETE /api/v1/me/status` only if the status is
  still exactly the one it set. Turning sharing off and *Disconnect* clear at once.
- **The person's own status wins.** A status set in FUDISLTE (meeting, focus, call, custom
  text, or even "coding" with another text) is never replaced or cleared. While it is
  shown the extension checks again at most every 5 minutes and takes over only after it
  has ended.
- **Recognising its own status:** the extension keeps, in VS Code's global state (local,
  not synced), the server origin, the user id, the window that set the latest status and
  the last three statuses sent (text and expiry). A status is its own only if kind,
  text and expiry instant match one of them. The record is written before the `PUT`, so
  a status whose answer was lost is still recognised.
- **Several windows** share that record: any window may refresh a status another window
  set, and only the window that set the latest one clears it on idle or exit.
- **Clock skew:** if the server's `Date` header differs from the local clock by more than
  a minute, the expiry is computed in server time (the API rejects past expiries).
- **Errors:** network failures, 5xx and 429 back off from 30 seconds doubling to
  15 minutes (±20 % jitter), honouring `Retry-After` up to an hour; other 4xx back off
  the same way. **401** stops all requests and shows a notification with *Connect*;
  **403** (token without `status:write`) does the same. Status bar tooltips say what
  happened and when the next attempt is.

Known limitation: reading the status and then deleting it leaves a short window in which
a status the person sets in between could be cleared. A conditional delete in the API
would close it (section 5).

## 3. Settings

Every setting has `"scope": "application"`: VS Code reads it from user settings only,
so a repository's `.vscode/settings.json` can neither turn sharing on nor send the token
to another server. Settings follow Settings Sync; the token never does.

| Setting | Default | Meaning |
| --- | --- | --- |
| `fudislte.serverUrl` | `""` | Server origin; set by *FUDISLTE: Connect*. `https://` only; `http://` only for `localhost`, `127.0.0.1` and `[::1]` (not `*.localhost`, which Node resolves through DNS) |
| `fudislte.presence.enabled` | `false` | Share "Coding" while active |
| `fudislte.presence.shareProject` | `false` | Add the workspace folder name |
| `fudislte.presence.shareLanguage` | `false` | Add the active editor's language |
| `fudislte.presence.idleMinutes` | `10` | Minutes without activity before the status is cleared (1–120) |

## 4. Commands and status bar

| Command | What it does |
| --- | --- |
| *FUDISLTE: Connect* | Asks for the server address, checks `GET /api/v1/meta` (no token), asks for the token (password box), validates it with `GET /api/v1/me`, stores it, then offers to turn sharing on |
| *FUDISLTE: Disconnect* | Clears the status this extension set, deletes the token |
| *FUDISLTE: Toggle Presence Sharing* | Turns sharing on or off (off clears at once); runs *Connect* when not connected |

The status bar item (right side) shows the state and toggles sharing: not connected
(plug), off, on but idle, sharing (tooltip shows the exact text), "your own status is
shown", retrying (warning colour, next attempt time), token rejected or missing scope
(error colour; clicking reconnects). The first time sharing is turned on, a message
shows the exact text that will be sent. All strings are in English and Turkish
(`package.nls*.json`, `l10n/bundle.l10n.tr.json`).

## 5. API contract

| Request | Token | Scope | Used for |
| --- | --- | --- | --- |
| `GET /api/v1/meta` | none | — | *Connect*: is this a FUDISLTE server (`product: "fudislte"`) |
| `GET /api/v1/me` | PAT | any valid token | *Connect* (validate, show the name); before every set and clear |
| `PUT /api/v1/me/status` | PAT | `status:write` | Set or refresh |
| `DELETE /api/v1/me/status` | PAT | `status:write` | Clear |

Every request carries exactly `Accept: application/json`, `Authorization: Bearer
fdp_<token>` (not on `/meta`), `User-Agent: fudislte-vscode-presence/<version>`, plus
`Content-Type: application/json` and `Content-Length` on the `PUT` (Node adds `Host` and
`Connection`). No cookies. The `PUT` body is built field by field:

```json
{ "kind": "coding", "text": "VS Code · fudislte-api · TypeScript", "expiresAt": "2026-10-30T12:15:00Z", "mute": false }
```

From `/me` the extension reads `user.id`, `user.displayName` and `user.status`
(`kind`, `text`, `expiresAt`) and drops everything else. Error bodies are the API's
`{"error": {"code", "message"}}`; only the code and status are used.

Redirects are never followed (the token must not travel elsewhere), requests time out
after 10 seconds and answers over 256 KiB are refused. Requests use Node's `http`/`https`
modules, which VS Code patches for its proxy and system-certificate settings (not
exercised here). They carry no `Origin`/`Sec-Fetch-Site`, so the API's cross-origin
protection lets them through (checked against the dev API).

**What the API must add (personal access tokens, Phase 6):**

1. Tokens `fdp_` + base64url of 32 random bytes; only their SHA-256 is stored (as for
   sessions), with name, scopes, created/last-used/expiry times and revocation.
2. `Authenticate` accepts `Authorization: Bearer fdp_…` (no cookie fallback when the
   header is present); disabled accounts, revoked and expired tokens get 401.
3. Default-deny scopes: a token reaches only routes that name a scope it holds.
   `GET /api/v1/me` for any valid token; `PUT`/`DELETE /api/v1/me/status` for
   `status:write`; everything else answers 403 `insufficient_scope`.
4. Tokens are created, listed and revoked by the person (session only, never by a
   token), shown once, audited.
5. Optional: a conditional `DELETE /api/v1/me/status` (`If-Match` on a status version)
   to remove the race in section 2.

## 6. Security notes

- The token lives only in VS Code's SecretStorage, under one key, together with the
  origin it was entered for. It is sent only to that origin: if `fudislte.serverUrl`
  changes, the extension stops (clearing its status on the old server) and asks to
  reconnect. It never appears in settings, global state, logs or messages.
- `extensionKind: ["ui", "workspace"]`: in remote windows it runs on the local machine,
  where the person's network reaches the FUDISLTE server.
- Untrusted and virtual workspaces are supported: the extension runs no workspace code
  and reads nothing from the workspace except, when opted in, a folder name.
- The bundle is not minified, so anyone can read what it sends; the `.vsix` contains no
  source maps.

## 7. Build, test, package, install

The extension is **not** part of the pnpm workspace; it uses npm in its own folder.

```powershell
cd extensions/vscode
npm ci                      # .npmrc blocks install scripts; esbuild uses its platform package
npm run typecheck           # tsc, no emit
npm test                    # node:test, TypeScript run by Node's type stripping (Node >= 22.18)
npm run package             # vsce: production build, then fudislte-presence-<version>.vsix
npm run check:vsix          # lists the .vsix, fails on source maps, sources, tests, secrets, absolute paths
```

Install: *Extensions* view → `…` → *Install from VSIX…*, or
`code --install-extension fudislte-presence-0.1.0.vsix`. Then *FUDISLTE: Connect*.

The extension is licensed like the rest of FUDISLTE (PolyForm Internal Use 1.0.0) and ships the license
as `LICENSE.txt`. `vsce` still runs with `--allow-missing-repository` because the
repository has no public URL yet; set `repository` in `package.json` before publishing to
the Marketplace or Open VSX.

## 8. Verification

Run 2026-10-30 on Windows 11, Node 24.19, npm 11.17.

| Check | Result |
| --- | --- |
| `npm run typecheck` | No errors (TypeScript 6.0.3, `@types/vscode` 1.90) |
| `npm test` | 59 tests pass. Status text: never contains path parts for 28 path-like folder names, stays ≤ 100 code points and unchanged by the API's normalization. URL and token validation. Schedule under fake timers: set on first activity, at most one update per 5 minutes, clear at the idle time, own status never replaced or cleared, several windows, back-off (30 s, 60 s, 120 s, …, 15 min), `Retry-After`, 401/403 stop, clock skew, lost answers, no timer spinning while a request is pending. A local HTTP server checks method, path, Bearer header, exact body keys, header allow-list, no redirects, timeouts and that nothing path-like is sent. The bundled extension against a fake VS Code API: connect, opt-in project name, toggle, disconnect, token rejected, server address changed, clear on exit |
| `npm run package` | `fudislte-presence-0.1.0.vsix`, 8 files, 18.7 KB: `extension.vsixmanifest`, `[Content_Types].xml`, `extension/package.json`, `package.nls.json`, `package.nls.tr.json`, `readme.md`, `dist/extension.js` (40 KB, no source map), `l10n/bundle.l10n.tr.json`; `vsce`'s secret scan passed |
| `npm run check:vsix` | OK: no source maps, sources, tests, secrets or absolute paths |
| Dev API (`127.0.0.1:8080`) | `GET /api/v1/meta` → `0.1.0-dev`; `GET /me`, `PUT` and `DELETE /me/status` with a Bearer token → 401 `unauthorized` (no PAT support yet; not rejected as cross-origin) |

**Not verified:** the extension inside VS Code (it was not installed into the editor on
this machine; the wiring was exercised against a fake of the VS Code API, whose
behaviour it only models: SecretStorage, global state shared between windows,
`WindowState.active`, deactivation time limits, proxy handling), and any successful
authenticated call against a real FUDISLTE API, which needs the PAT work above.

## 9. Dependencies (build time only)

Nothing is bundled from third parties: `dist/extension.js` contains only this code.

| Package | License | Use |
| --- | --- | --- |
| esbuild 0.28 | MIT | Bundling |
| typescript 6.0 | Apache-2.0 | Type checking |
| @types/vscode 1.90, @types/node 20.19 | MIT | Types |
| @vscode/vsce 4.1 | MIT | Packaging |

`@vscode/vsce` brings build-time dependencies under other licenses: `@vscode/vsce-sign`
and its platform binary (Microsoft Software License Terms; usable with VS Code to
develop and test, used by vsce only for signing), `istextorbinary`, `binaryextensions`,
`textextensions`, `editions`, `version-range` (Artistic-2.0, via secretlint) and
`minimatch`, `sax` (BlueOak-1.0.0). None of them ships in the `.vsix`.
