# Threat Model

Scope: browser and desktop clients, the VS Code extension, Caddy, the Go API, PostgreSQL,
the API's data directory (attachments), outgoing email, and the optional AI worker with
its vector database and model servers.
Method: STRIDE per trust boundary. "Status" says what is actually implemented, and in
which phase or increment.

FUDISLTE has **no passwords**: people sign in with one-time codes sent to their work email
(ADR-0006).

## Assets
Mailbox access (it is the credential) · one-time codes · sessions · personal access tokens · room passwords (hashes) · voice and video streams · LiveKit API secret · organization
membership and roles · email-domain join rules · member directory (names, emails) · audit
log · messages and attached files · projects, tasks, comments and whiteboard scenes · the AI vector index (copies of message and document text) · agent runs and their delegated tokens · the instance itself (first-run takeover).

## Trust boundaries
1. Internet → Caddy (TLS termination)
2. Caddy → API (private Docker network)
3. API → PostgreSQL (private network, dedicated role)
4. API → SMTP relay (STARTTLS or implicit TLS)
4a. API → data directory (attachments on a private volume, ADR-0009)
5. Remote web content → Electron main process (preload bridge / IPC)
6. Tenant ↔ tenant inside one instance
7. VS Code extension → API (personal access token over HTTPS)
8. API ↔ AI worker (internal network `ai`, signed requests in both directions)
9. AI worker → model server and its vector database (internal network `ai-backend`, no internet route)

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| S1 | Guessing a sign-in code | 8 digits (10⁸), 10-minute lifetime, 5 attempts per code, newer code supersedes older, per-address and per-IP issuance and verification limits (≈0.3 %/year worst case, ADR-0006) | Done (single node) |
| S2 | Learning which emails have accounts | Identical response for every address; eligibility lookup and sending happen after the response in a background outbox | Done |
| S3 | Mailbox compromise = account compromise | Documented; organizations protect mailboxes with MFA; OIDC/SAML SSO in Phase 10 | Accepted risk |
| S4 | Phishing of codes | Emails state the server address and "never share this code"; codes expire in 10 minutes and are single use | Partially mitigated |
| S5 | Session theft via XSS | HttpOnly cookies; strict CSP on the web app; React escaping; no `dangerouslySetInnerHTML` | Done |
| S6 | Session fixation / reuse | New random token per sign-in; hash-only storage; revocation; idle + absolute expiry | Done |
| S7 | Instance takeover on first boot | Setup requires the setup token **and** a code delivered to the owner's email; one-time under an advisory lock | Done |
| S8 | Forwarded invitation link used by someone else | Accepting as a new person requires a code sent to the invited address | Done |
| S9 | Domain auto-join abused (e.g. gmail.com) | Public email providers rejected; join roles may not carry management permissions; only `org.manage` can register domains; joining happens only at account creation | Done |
| T1 | CSRF on state-changing endpoints | `http.CrossOriginProtection` + `SameSite=Lax` | Done |
| T2 | Mass assignment | Explicit request DTOs, `DisallowUnknownFields`, 1 MiB body limit | Done |
| T3 | Email header injection | Recipient and subject reject CR/LF; recipients are normalized addresses | Done |
| T4 | SMTP downgrade / credential exposure | STARTTLS required by default (fails if not offered), TLS 1.2+, server name verified; unencrypted SMTP with credentials only to loopback relays | Done |
| R1 | Repudiation of admin actions | Audit events written in the same transaction as the change, with actor, IP, user agent | Done |
| I1 | Cross-tenant data access | Membership loaded per request; org ID never taken from the body; composite FKs for role and domain-role assignment; tests for cross-org access | Done |
| I2 | Workspace existence disclosure | Non-members get 404 | Done |
| I3 | Secrets in logs | Session tokens never logged; codes logged only by the development-only log transport, which production configuration rejects | Done |
| I4 | Database leak exposes codes | Codes stored as salted SHA-256; a leaked active code hash could be brute-forced offline within its 10-minute life | Accepted risk |
| E1 | Privilege escalation via roles | Role hierarchy (position), grant only held permissions, owner-only Owner assignment, last-owner protection | Done |
| E2 | Renderer compromise → OS access (desktop) | Sandbox, context isolation, no Node, validated IPC by sender origin, navigation/window/permission allow-lists, custom protocol instead of `file://`, Electron fuses | Done (smoke-tested) |
| E3 | Malicious link → code execution (desktop) | `shell.openExternal` only for `https:`, `http:`, `mailto:` | Done |
| I5 | Private channel disclosure | Private channels visible only to members (administrators included); anything not visible answers 404; channel membership references workspace membership, so leaving a workspace removes it | Done (2.1) |
| I6 | Live events reaching people who lost access | Events addressed to users; recipients computed from current channel membership at publish time; sign-out and session revocation close that session's streams; streams end after 30 minutes and re-authenticate (ADR-0008) | Done (2.1) |
| I7 | Reading or moderating other people's direct messages | Conversations visible only to participants (404 for everyone else, administrators included); moderation applies to channels only; members without `members.view` (guests) can only start conversations with people they share a channel with | Done (2.2) |
| T5 | Script injection through messages | Message text rendered as React text (never HTML); only `http(s)` URLs become links, opened with `noopener`; control characters stripped server-side | Done (2.1) |
| D1 | Email flooding a victim with codes | Per-address limit: 3 codes, then 1 per 10 minutes | Done |
| D3 | Message flooding / slow event consumers | Per-user posting limit (burst 20, then 5/s) and reaction limit (burst 40, then 10/s); 4000-character messages; at most 20 reaction kinds per message and 50 pins per channel; a stream whose buffer fills is dropped instead of blocking publishers; load-tested to 1,000 streams and about 200,000 events/s without a dropped event (fast clients only, [load-testing.md](../architecture/load-testing.md)) | Done (2.1–2.3, single node) |
| I8 | Presence and status leaking beyond the workspace | Presence and status go only to people sharing a workspace who may view the member directory; the `mute` flag is never sent to others; typing goes only to channel members; a person can only report activity for their own streams | Done (2.4) |
| I9 | Notifications revealing private channels | Notifications are created only for current channel members, so mentioning someone in a channel they cannot see tells them nothing | Done (2.4) |
| T6 | Spoofed mentions or reactions | Mentions are `<@id>` tokens resolved by the server to workspace members (others show as unknown); reactions accept emoji code points only and are rendered as text | Done (2.3) |
| I10 | Files reaching people without access | A file is served only to people who may read its channel (404 otherwise, the same as a missing file); an upload not yet sent is visible to and deletable by its uploader only; files are stored by ID under the data directory, never under the uploaded name; deleting a message, or retention, deletes its files | Done (2.5) |
| T7 | Malicious uploads running in the browser (stored XSS, content sniffing) | Content type detected from the bytes, the client's claim ignored; only PNG, JPEG, GIF and WebP served inline, everything else as `application/octet-stream` with `Content-Disposition: attachment`; every file sent with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`; names reduced to a base name without control characters and encoded in the header | Done (2.5) |
| D4 | Filling the server's disk with uploads | Per-file limit `FUDISLTE_MAX_UPLOAD_MB` (default 25) enforced while streaming, partial files removed; per-user upload limit (burst 20, then one per 2 s); unsent uploads removed after 24 hours. No per-workspace quota yet | Partially mitigated (2.5) |
| I11 | Search revealing messages the caller cannot read | The search query itself is limited to channels the caller has joined plus public channels they may join (`channels.join`); private channels and other people's conversations never match | Done (2.5) |
| R2 | Messages kept longer than the organization's policy | Workspace retention (30–3650 days) applied hourly to messages and their files; changes audited. Deleted rows can survive in database backups until those rotate | Done (2.6) |
| E4 | Room password used to bypass authorization | Visibility and the access list are checked before the password; guests and people off a restricted room's list are refused with the right password (404, or 403 for managers who may only see it); `rooms.manage` manages settings but never admits (ADR-0010) | Done (3) |
| S10 | Guessing a room password | Argon2id (19 MiB, 2 passes), at least 8 characters; five guesses per person and room, then one a minute; every wrong guess audited | Done (3, single node) |
| I12 | Access surviving a revoked or expired room admission | Admission is channel membership with an expiry; every membership query (messages, files, search, notifications, live events) ignores expired rows; a password or access change ends admissions in the same transaction; a job removes expired rows every 30 s and tells clients | Done (3) |
| D5 | Memory exhaustion through password hashing | At most four Argon2id computations at once (≈76 MiB); stored parameters accepted only up to 256 MiB | Done (3) |
| S11 | Claiming someone else's email domain for auto-join | A domain admits people only after a DNS TXT record with a per-domain token is published (1.x); public providers and management roles are refused | Done (1.x) |
| S12 | A departed person keeps access | Instance administrators disable the account: codes stop, sessions are revoked and live streams close in one step | Done (1.x) |
| T8 | Markup injection in emails | Emails rendered with html/template (escaped values); header values reject line breaks | Done (1.x) |
| I13 | Media reaching people without access | The API alone signs LiveKit tokens, only for admitted people, with publish sources limited and expiry capped at the admission; ending an admission calls RemoveParticipant at once; a 30 s sweep and every participant_joined webhook remove anyone not admitted or disabled (ADR-0011) | Done (4) |
| S13 | Forged LiveKit webhooks | Webhooks need a JWT signed with the API secret carrying the SHA-256 of the body; others get 401 | Done (4) |
| E5 | Desktop page capturing screen, camera or microphone unnoticed | The shell grants media and display capture only to the connected server; screen sharing always goes through the app's own picker window, so the server's page never sees the other windows or their thumbnails and cannot pick for the person; the web app shows camera and screen tiles while they are on | Done (4) |
| I14 | Meetings and their calls reaching people who were not invited | Only the organizer and invitees see a meeting (404 for everyone else, workspace owners included); invitations reference workspace membership through composite keys, so they never cross workspaces and end when someone leaves; LiveKit tokens only inside the join window (15 minutes before the start to 2 hours after the end), expiring when it closes; canceling, removing an invitee or moving the meeting disconnects at once, and the 30 s sweep and every participant_joined webhook apply the same rule to `fudislte-meeting-*` rooms | Done (4.3) |
| I15 | Meeting emails disclosing addresses | An invitation's calendar file names only the organizer and its recipient; other invitees are never listed. The organizer's address is visible to every invitee, guests included, as in any calendar invitation | Accepted risk (4.3) |
| D6 | Email flooding through meeting invitations | Only `meetings.create` holders schedule; at most 200 invitees; creating, changing and canceling limited per person (burst 20, then one per 3 s); title and agenda changes send no email; disabled accounts get none | Done (4.3, single node) |
| T9 | Header or calendar injection through meeting titles and names | Attachment names and types reject line breaks and quotes; calendar TEXT values escaped (`\ ; ,` and line breaks), names quoted with double quotes removed, lines folded at 75 octets; email HTML through html/template | Done (4.3) |
| S14 | Stolen or guessed personal access token | 256-bit random tokens stored only as hashes, with expiry and revocation; the extension keeps its token in VS Code's secret storage, bound to the server it was entered for; HTTPS only (HTTP only for localhost); redirects never followed | Client done (6); API planned |
| E6 | Token used beyond its purpose | Deny-by-default scopes: `status:write` reaches only `GET /me` and `PUT`/`DELETE /me/status`; tokens cannot create tokens | Client done (6); API planned |
| I16 | Developer presence oversharing | Off by default; the folder name and the language are separate opt-ins; path-like names dropped; file names, contents and git data never read; no telemetry; statuses expire after 15 minutes; a status the person set themselves always wins (ADR-0013) | Client done (6) |
| T10 | Repository settings turning sharing on or redirecting the token | Every extension setting is user-level only, so a repository's `.vscode/settings.json` cannot change them; the token goes only to its own server | Client done (6) |
| D7 | Status write flooding | At most one read and one write per window every 5 minutes; back-off from 30 s to 15 min on errors, honouring `Retry-After`; a per-token server limit is planned | Client done (6); API planned |
| I17 | Backup theft or leak (messages, files, Caddy keys) | `backup.sh` encrypts with age to offline recipients and refuses to write plaintext unless told `--unencrypted`, or when age is missing; the install skill never creates the private key on the server; backup directories private (0700/0600); the `.env` secrets are never in a backup; tokens, codes and room passwords only as hashes | Done (10); not yet run with the real age binary |
| T11 | Restoring a damaged or tampered backup | Checksums and the manifest verified before anything changes; the dump restored in one transaction; row counts of every table and the SHA-256 of every file compared afterwards. These catch damage, not forgery by someone who can write to the backup storage: keep backups on storage the server cannot change (append-only, object lock, pulled by another host) | Done (10); forgery: operational |
| E7 | A restore bringing back access revoked after the backup | `restore.sh --revoke-sessions` revokes every restored session before the API starts; operators redo account disables, member removals and room password changes made since the backup ([backup-restore.md](../deployment/backup-restore.md#after-a-restore)) | Partially mitigated (10) |
| D8 | Host loss or ransomware destroying the backups | Off-site copies with versioning or object lock, checked after the copy (documented) | Operator responsibility |
| D9 | Presence storm when everyone reconnects | Measured: about n²/2 presence events, handled at 1,000 people without loss; batch presence updates before large deployments | Open for large deployments |
| S15 | Forged or replayed requests to the AI worker, or forged agent callbacks to the API | HMAC-SHA256 over timestamp, method, request target (raw path and query) and body; 300 s skew window; constant-time comparison; body verified before routing; the worker publishes no port and is reachable only on the internal `ai` network; callbacks signed the same way (ADR-0012) | Done (worker); API verification pending |
| I18 | AI search revealing content the person cannot read | The API computes the allowed access lists from current memberships on every request; the worker filters by workspace and access list inside the SQL query (pgvector iterative scan), tested with forbidden nearer neighbours; the worker never decides permissions | Done (worker); API mapping pending |
| I19 | Workspace content sent to a third-party model | Local model servers by default; a model URL outside the private network is refused unless `FUDISLTE_AI_ALLOW_EXTERNAL_LLM=true`, and then only over HTTPS; `/healthz` reports it; the worker's networks have no internet route; prompts and request bodies are never logged | Done |
| T12 | AI inventing decisions, action items or tasks | Every decision and action item must cite input items, validated in code; invented entries are dropped and counted; assignee hints kept only when a cited item names them; suggested tasks are created only when a person accepts them | Done (worker); a summary's free text is not machine-checked |
| E8 | Agent performing destructive actions without approval | Destructive tools pause the run; the approval is bound to SHA-256 of the tool and its canonical arguments and is single use; tampered or reused approvals are refused and audited; the API re-checks the approval on the callback; no shell, file or network tools; limits on steps, tool calls and time | Done (worker); API callback check pending |
| E9 | Prompt injection through messages, documents or tool results | Content is marked as data in prompts; tools are limited to the person's own permissions; destructive actions need approval of the exact call; no exfiltration path (local model, internal networks, no network tools) | Partially mitigated |
| R3 | Repudiation of agent actions | Every step audited with who approved or rejected it; the API stores the run record as the authoritative copy | Done (worker); API storage pending |
| I20 | AI index outliving deletion or retention | The API calls `DELETE /v1/index` for deleted content, retention and workspace deletion | Pending (API) |
| D10 | Resource exhaustion through AI requests | 8 MiB JSON and 100 MiB audio limits, one transcription at a time, at most 64 prompt batches, runs capped at 32 steps, 64 tool calls and 900 s, at most 200 runs in memory | Done (single node) |
| S16 | Impersonating another viewer on a whiteboard (forged window IDs, names or cursors) | Viewer entries are keyed by the signed-in person and a random window ID, so a window ID seen in an event cannot replace or remove someone else's entry; names and colours in scene and cursor events come from the session, never from the request; cursor input validated (bounded coordinates, tool, button, at most 200 element IDs) | Done (5) |
| T13 | Overwriting or corrupting whiteboard and task content | Only editors write (project members of an active project; `boards.create` for workspace boards); the server keeps the higher version of each element and, on ties, the lower nonce in one SQL statement, so stale or replayed copies change nothing and deletions stay as tombstones; batches limited to 500 elements of 256 KiB in 4 MiB, element IDs and types allow-listed (images and embeds refused), at most 10,000 live shapes per board; task descriptions and comments follow the message rules and are rendered as React text | Done (5) |
| I21 | Private projects, their tasks or boards reaching non-members (lists, search, events, links, room panels, activity) | Private projects visible to members only — 404 for everyone else, workspace owners and administrators included; every list, search, task, activity and board query applies the rule in SQL; `task.updated` and `project.updated` recipients computed from current membership at publish time, board events re-checked at every send; links and activity name a channel or room only for people who may see it; a room's linked tasks only for admitted people and visible projects; composite foreign keys keep projects, tasks, labels, sprints, assignees, links and boards in one workspace | Done (5) |
| D11 | Flooding through task changes, comments, whiteboard writes or cursors | Per-person limits: task changes burst 60 then 10/s, comments burst 20 then 5/s, scene writes burst 40 then 20/s, cursors beyond 25/s dropped; bounded batches and boards; at most 12 statuses, 50 labels and 1,000 members per project, 10 assignees, 10 labels, 50 checklist items and 20 links per task; viewer entries expire after 30 s; a client whose event buffer fills is disconnected and resyncs | Done (5, single node) |
| E10 | Changing a project without the right role (viewers, guests, members acting as leads) | Task changes need project membership in an active project (403 `not_project_member`, 409 `project_archived`); settings, workflow, labels, members, sprints and archiving need a lead or `projects.manage`; only project members can be assigned (foreign key); a project keeps at least one lead; `projects.manage` is a management permission that email-domain join roles cannot carry | Done (5) |
| R4 | Repudiation of project access changes and deletions | `project.created`, `project.updated` (name, key, visibility), `project.members_changed`, `project.archived`/`project.restored`, `task.deleted`, `board.created` and `board.deleted` audited in the same transaction; every task change leaves an activity entry with its author | Done (5) |
| D2 | Slowloris / large bodies | Server read/write/idle timeouts, body size limits | Done |
| — | Replay of an identical signed AI worker request (same method, target and body) within 300 s by someone able to capture internal traffic | Internal networks only; approvals single use; index writes idempotent | Accepted risk |
| — | Distributed rate limiting | Redis/Valkey-backed limiter | With multi-replica support (ADR-0008) |
| — | Encryption at rest | Full-disk / volume encryption guidance; PostgreSQL TDE is not native | Documented in deployment guide |
| — | Signed desktop updates | Code signing + `electron-updater` signature verification | Phase 10 |

## Known limitations
- Attachments are not scanned for malware; the browser protections above keep them from
  running in FUDISLTE, but a downloaded file is as safe as its sender.
- Rate limiter state is per API process; restarts reset it.
- Instance-level events (sign-ins) are recorded but only workspace events are viewable in
  the UI.
- No end-to-end encryption. FUDISLTE does not claim E2EE anywhere.
- Whiteboard viewer lists and cursors are per API process; deleted shapes stay as
  tombstones (no compaction yet); images cannot be placed on whiteboards.
- AI summaries' free text is not machine-checked and must be labelled as AI-generated;
  agent runs live in the worker's memory and are lost when it restarts.
