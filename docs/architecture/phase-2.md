# Phase 2 Architecture — Messaging

Status: **Done** — increments 2.1 to 2.6 implemented and verified (see "Verification").

Phase 2 turns the foundation into a chat product (mockup "Yeni 04", docs/design). It is
built in increments; each one ends with tests, a browser check and updated docs.

| Increment | Scope | Status |
| --- | --- | --- |
| **2.1 Channels** | Public and private channels, default channel, join/leave, channel members, messages (send, edit, delete, history), unread counts, live updates | Done |
| **2.2 Direct messages** | One-to-one and group DMs (up to 9 people), notes to self, "Messages" inbox | Done |
| **2.3 Conversations** | Threads, reactions, mentions, pinned messages | Done |
| **2.4 Presence** | Online/away, status (meeting, coding, focus, call, custom), typing, notifications | Done |
| **2.5 Files and search** | Attachments on the server's disk (ADR-0009), image previews, channel files tab, message search | Done |
| **2.6 Channel administration** | Archive and restore channels, workspace message retention | Done |

## 1. Data model (migration 00004)

```
channels         id, org_id, name, topic, visibility (public|private), is_default,
                 created_by, created_at, archived_at
channel_members  (channel_id, user_id), org_id, joined_at, last_read_id
messages         id (UUIDv7, time-ordered), org_id, channel_id, author_id, body,
                 created_at, edited_at
```

- Tenant isolation as in Phase 1: composite foreign keys tie every row to one
  organization; `channel_members` references `memberships (org_id, user_id)`, so removing
  someone from a workspace removes them from all of its channels in the same statement.
- Channel names are unique per workspace, lower-case, with letters (including Turkish
  ones), digits, `-` and `_`, at most 40 characters. "Müşteri Destek" becomes
  `müşteri-destek`.
- Every workspace has one default public channel (`genel` / `general`, in the creating
  request's language). A database trigger adds each new workspace member whose role may
  join public channels, so every join path (setup, invitation, email domain) is covered.
- Message IDs are UUIDv7, so ordering by ID is ordering by time and serves as the
  pagination cursor. Unread counts compare message IDs with `last_read_id`.
- Deleting a message removes it. A moderator's deletion of someone else's message is
  recorded in the audit log (without the text).

### Direct messages (migration 00005)

A direct conversation is a channel with `kind = 'direct'`: it has no name and a fixed,
sorted `participants` array (the caller included, 1–9 people). Messages, read markers,
unread counts, history and live events therefore work exactly as in channels.

- One conversation per set of people: a unique index on `(org_id, participants)`.
  Opening a conversation is find-or-create; it also re-adds participants who left and
  rejoined the workspace.
- A conversation appears in the other participants' lists once it has a message, so
  opening and abandoning one notifies nobody.
- Membership is fixed: no joining, leaving, adding, removing or renaming.
- To start a conversation the caller needs `members.view`, or must already share a
  channel with every other participant. Guests can therefore only write to people they
  work with.
- Moderators (`messages.manage`) delete other people's messages only in channels, never
  in direct conversations.

### Threads, reactions, mentions and pins (migration 00006)

```
messages            + parent_id (thread root), deleted_at, pinned_at, pinned_by
message_reactions   (message_id, user_id, emoji), created_at
message_mentions    (message_id, user_id)
```

- **Threads** are one level deep: a reply's `parent_id` is a top-level message of the
  same channel (composite foreign key). Channel history, unread counts and read markers
  cover top-level messages only; each root carries a summary (reply count, last reply
  time and the latest reply, shown inline under the root as in the mockup).
- Deleting a root that has replies keeps a "message deleted" placeholder so the thread
  survives; the placeholder disappears with the last reply. Other deletions remove the
  message.
- **Reactions**: any channel member adds or removes their own; an emoji is 1–16
  characters of emoji code points only, and a message holds at most 20 different ones.
- **Mentions** are stored in the text as `<@user-id>` tokens; the API resolves them to
  names for display and records them in `message_mentions` (used for notifications in
  2.4). Only workspace members can be mentioned; clients show other tokens as unknown.
- **Pins**: any channel member pins or unpins a message; at most 50 per channel.

### Presence, status, typing and notifications (migration 00007)

```
users          + status_kind, status_text, status_expires_at, status_mute
notifications  id, org_id, user_id, kind (mention|reply), channel_id, message_id,
               actor_id, created_at, read_at
```

- **Presence** comes from the live event streams, not from the database: a person is
  *online* while one of their streams is open and active, *away* when every open stream
  reports idle (no input for 5 minutes, or the window hidden), and *offline* 15 seconds
  after their last stream closes (the grace period hides reloads). Streams identify
  themselves with the connection ID sent in the `ready` event.
- **Status** is chosen by the person: meeting, coding, focus, call or custom text, with
  an optional end time (30 minutes to "today"). `status_mute` silences desktop
  notifications while the status lasts. Expired statuses are ignored when read; clients
  also hide them at `expiresAt`.
- Presence and status are shown to members of the same workspaces who may view the
  member directory, and pushed to them as `presence.changed` events. Changes that pile
  up while earlier ones are being sent (a restart, everyone reconnecting) are merged:
  each person's latest state goes out once, and two queries serve the whole batch.
- **Typing** is ephemeral: a client reports typing at most every 3 seconds; the API
  relays it to the other channel members (`typing`, never stored), and clients drop it
  after 6 seconds without a refresh.
- **Notifications** are stored for people a message mentions and for the participants of
  a thread (its author and earlier repliers) when someone replies — only for current
  channel members and never for the author. They feed the bell in the top bar
  (`notification.created` events) and desktop notifications. Direct messages produce
  desktop notifications from their own unread counts; they are not stored again.
- Desktop notifications are a per-device choice (all, mentions and replies only, off)
  and are skipped while the status mutes them or the conversation is on screen.

### Files, search, archive and retention (migration 00008)

```
attachments    id, org_id, channel_id, uploader_id, message_id (null until sent),
               name, content_type, size, sha256, created_at
messages       + search tsvector (generated from the text)
organizations  + retention_days (null: keep forever)
```

- **Attachments** (ADR-0009): upload to a channel, then send them with a message (up to
  10); a message may consist of attachments only. They inherit the message's
  visibility. Images show as previews; other files as cards. Each channel has a
  "Dosyalar" tab listing its files. Deleting a message deletes its files; uploads that
  are never sent are removed after 24 hours.
- Files live under `FUDISLTE_DATA_DIR` (one file per attachment, named by its ID); the
  database keeps the name, the content type detected from the bytes, the size and a
  SHA-256 checksum. Only PNG, JPEG, GIF and WebP are shown inline; everything else is
  served as a download. The size limit is `FUDISLTE_MAX_UPLOAD_MB` (default 25).
- **Search** uses PostgreSQL full-text search over message text (`simple`
  configuration, so Turkish and English both work without stemming; every word must
  match, the last one as a prefix). It covers the channels and conversations the caller
  has joined, plus public channels they may join; filters: channel and author. Results
  show the matching message with its channel and open it in place (threads in the
  thread panel). Mention tokens are not searchable.
  Known limitation: PostgreSQL lower-cases with the database locale, so a capital "I"
  becomes "i", not "ı": all-caps "ÇAĞRI" is not found by "çağrı". Lower-case and
  mixed-case text is unaffected.
- **Archive**: the channel's creator or a `channels.manage` holder archives a channel. It
  disappears from the sidebar, keeps its history and files, becomes read-only and is
  listed as archived in "Kanallara göz at"; restoring brings it back for its members.
  The default channel cannot be archived.
- **Retention**: workspace owners (`org.manage`) may delete messages and files older
  than a number of days (30–3650, or keep forever). A background job applies it hourly:
  files go with their messages, and an expired thread root with newer replies stays as a
  "message deleted" placeholder. Changes are audited.

## 2. Access rules

| Permission | Allows | Default roles |
| --- | --- | --- |
| `channels.join` | See and join public channels; join the default channel automatically | Everyone except Guest |
| `channels.create` | Create public and private channels | Everyone except Guest |
| `channels.manage` | Rename any visible channel, remove channel members | Owner, Administrator |
| `messages.manage` | Delete other members' messages | Owner, Administrator |

- Private channels are visible only to their members — workspace administrators
  included. Anything not visible answers 404, so its existence is not disclosed.
- Reading a public channel requires `channels.join`; posting requires channel membership.
- Any channel member may add workspace members to the channel. The channel's creator and
  `channels.manage` holders may rename it and remove members; everyone may leave, except
  from the default channel.
- Only the author edits a message. The author or a `messages.manage` holder deletes it.
- Files follow their channel: whoever may read the channel may download its files (404
  otherwise). An upload that has not been sent yet is visible to, and deletable by, its
  uploader only.
- Archived channels are read-only for everyone: no messages, edits, deletions,
  reactions, pins, uploads, renames or joins until restored.
- `channels.manage` and `messages.manage` are management permissions: roles that carry
  them cannot be used for automatic joining by email domain.

## 3. API (all under `/api/v1/orgs/{orgID}`)

| Method and path | Purpose |
| --- | --- |
| `GET /channels` | Channels the caller has joined, with unread counts |
| `GET /channels/browse` | Public channels with member counts and the caller's membership |
| `POST /channels` | Create (`name`, `topic`, `visibility`, `memberIds`) |
| `GET /channels/{id}` · `PATCH /channels/{id}` | Read; rename or change topic |
| `POST /channels/{id}/join` · `POST /channels/{id}/leave` | Join a public channel; leave |
| `GET /channels/{id}/members` · `POST …/members` · `DELETE …/members/{userID}` | Channel members |
| `GET /channels/{id}/messages?before=&limit=` | History, newest page first |
| `POST /channels/{id}/messages` · `PATCH`/`DELETE …/messages/{messageID}` | Send (`body`, optional `parentId` for a thread reply), edit, delete |
| `GET …/messages/{messageID}/replies` | A thread: root and all replies |
| `POST …/messages/{messageID}/reactions` · `DELETE …/reactions?emoji=` | Add or remove the caller's reaction |
| `PUT`/`DELETE …/messages/{messageID}/pin` · `GET /channels/{id}/pins` | Pin, unpin, list pins |
| `POST /channels/{id}/read` | Mark read up to a message |
| `GET /conversations` | The caller's direct conversations, newest activity first, with participants and last message |
| `POST /conversations` | Open (find or create) a conversation with `userIds` |
| `POST /channels/{id}/typing` | "Typing" signal (`parentId` for a thread); relayed, never stored |
| `GET /presence` | Presence and status of every member (needs `members.view`) |
| `GET /notifications` · `POST /notifications/read` | Latest 50 with unread count; mark read by `ids`, `channelId` or `all` |
| `GET /api/v1/events` | Live event stream (ADR-0008); its `ready` event carries the connection ID |
| `POST /api/v1/presence` | `{connectionId, active}`: this window is in use or idle |
| `PUT`/`DELETE /api/v1/me/status` | Set (`kind`, `text`, `expiresAt`, `mute`) or clear the caller's status |
| `POST /channels/{id}/files` · `GET /channels/{id}/files` | Upload one file (multipart `file`); list the channel's sent files |
| `GET /files/{fileID}[?download=1]` · `DELETE /files/{fileID}` | Download (images inline unless `download`); discard an unsent upload |
| `GET /search?q=&channelId=&authorId=&limit=` | Message search, newest first (limit 1–50, default 20) |
| `POST /channels/{id}/archive` · `POST /channels/{id}/unarchive` | Archive or restore a channel |
| `GET /retention` · `PUT /retention` | Read; set (`days`, null keeps forever; `org.manage`) message retention |

Conversations use the channel endpoints for history, messages, read markers and their
participant list; endpoints that change membership or names answer 409.

Messages carry everything clients display: `parentId`, `mentions` (names for the
`<@id>` tokens), `reactions`, `pinned`, `deleted` and, for roots with replies, `thread`
(reply count, last reply time, latest reply), and `attachments` (ID, name, content
type, size, `image`). Sending takes `attachmentIds` from earlier uploads.

Rate limits per user: posting burst 20, then 5 per second; reactions burst 40, then 10
per second; typing signals burst 3, then 1 per second (extra ones are ignored);
uploads burst 20, then one every 2 seconds.

Events: `message.created`, `message.updated` (also thread summaries, pins and
placeholders), `message.deleted`, `message.reactions`, `channel.updated`,
`channel.joined`, `channel.left`, `channel.members` (new member count), `channel.read`,
`channel.archived` (`archived`: true or false),
`typing`, `notification.created`, `notification.read` — each with `orgId`; channel and
message events with `channelId`, message events with `parentId` for replies — and the
user-level `presence.changed` (`userId`, `state`, public `status`).

## 4. Client

- The sidebar lists joined channels under "Kanallar" with unread badges, a "+" to create
  a channel and "Kanallara göz at" to browse public ones.
- The channel page follows the mockup: header with name, topic and member count, the
  message list grouped by author and day, and a composer (Enter sends, Shift+Enter adds a
  line, ↑ edits your last message). Message text supports line breaks, links and code
  blocks; it is rendered as text, never as HTML.
- Direct messages: "Mesajlar" in the main navigation (inbox with last message, search
  and total unread badge), a "Direkt mesajlar" sidebar section (eight most recent, "show
  more"), a "Yeni mesaj" dialog (one person, or up to eight for a group) and "Mesaj
  gönder" on every profile card. Conversations are named after the other people and use
  the same page, list and composer as channels.
- Conversation features (2.3), as in the mockup: reaction chips with who reacted and an
  emoji picker (a built-in set of 50, no library); a hover toolbar with three quick
  reactions, reply, pin, edit and delete; the latest reply shown under its root with
  "N yanıt", opening a thread panel beside the conversation (linkable with `?thread=`;
  the people list steps aside); "@" in the composer suggests channel members and
  mentions render as names, highlighted when they mention you; the "Sabitlenen mesaj"
  bar with "Mesaja git" and a list of all pins.
- Presence (2.4), as in the mockup's people list: a dot on avatars (green online, gray
  away, the status color — red meeting, blue coding, purple focus, amber call — when a
  status is set; none offline) and the status under the name; offline people are dimmed.
  "Durum ayarla" in the account menu sets a status with a note, an end time and "mute
  notifications". The composer shows "Ayşe yazıyor…". The bell in the top bar lists
  mentions and replies and opens them (threads in the thread panel). Desktop
  notifications are chosen per device under *My account*.
- Files (2.5): the composer's paperclip, drag and drop and pasting attach up to 10
  files, uploaded at once and shown with progress, errors and a remove button; messages
  show image previews and file cards; the channel's "Dosyalar" tab lists every file with
  a name filter and downloads.
- Search (2.5): the command palette (Ctrl+K) shows matching messages as you type, and
  "Tüm sonuçlar" opens the search page (channel and author filters, matches
  highlighted). A result opens the conversation scrolled to the message (`?message=`),
  or its thread.
- Administration (2.6): "Kanalı arşivle" in the channel menu, with confirmation; an
  archived channel shows a banner with "Geri yükle" instead of the composer. The
  workspace settings have a "Mesaj saklama" card for owners.
- Tasks, Wiki and call buttons from the mockup appear with the phases that build them.
- One event stream per tab updates the query cache; after a reconnect the client
  refetches channels and open conversations.

## 5. Verification

### Phase 2 exit criterion

The roadmap's exit criterion — two users chat in real time, and removed members stop
receiving events — is covered by the 2.1 tests (events stop at once after removal from a
channel or the workspace, and at sign-out) and by the two-user browser checks of every
increment.

### Increments 2.5 and 2.6 (files, search, archive, retention)

| Check | Result |
| --- | --- |
| `pnpm check:api` | 74 Go tests pass. New: disk store round trip, and an oversized file leaves nothing behind; upload and send, including a files-only message; the content type comes from the bytes (an HTML file is served as a download, never as HTML); images inline with a sandbox CSP, `?download=1` forces a download; unsent uploads hidden from others and discarded by their uploader; size limit, empty files, reusing a sent file and sending someone else's upload rejected; the channel files list; private-channel files 404 for outsiders; deleting a message deletes its files from disk; search by prefix, case-insensitive, every word must match, operators ignored, author filter, private channels kept out of others' results; only the creator or `channels.manage` archives, never the default channel; archived channels are read-only (posting, reacting, deleting), leave the sidebar and stay in "browse" with their history; restoring; retention set by owners only, 30-day minimum; the cleanup job removes expired messages and their files, keeps an expired root with a newer reply as a placeholder, and removes unsent uploads after a day |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 36 Vitest tests (new: previews of files-only messages, sizes, search words, file icons) |
| Browser | Uploads by API and by pasting into the composer; image preview and file card; a files-only message; the "Dosyalar" tab; the search page with highlighted matches; a palette result opens the channel scrolled to the highlighted message; archive banner and "Geri yükle"; the retention card in workspace settings |
| Docker | `scripts/wsl/docker-local.sh up` rebuilds the stack; the API starts healthy as the non-root user with the `api-data` volume |
| Desktop | `pnpm --filter @fudislte/desktop smoke` passes |

### Increment 2.4 (presence, status, typing, notifications)

| Check | Result |
| --- | --- |
| `pnpm check:api` | 69 Go tests pass. New: offline → online with a stream, away when the stream reports idle, back online, offline after the grace period; another person's connection ID is rejected; status set, shown to others without `mute`, validated (kind, custom text, end time) and cleared; guests cannot list presence; typing reaches other members; mentions notify channel members only, thread replies notify the root author and earlier repliers but not the author, a mention wins over a reply, edits notify newly mentioned people; reading by ID, by opening the channel or all; hub unit test for away, reloads within the grace period and going offline |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 33 Vitest tests (new: presence dot colors, labels, ended statuses) |
| Browser, two users | Dana (an open stream) shows online; her "Toplantıda · Sprint planlama" status appears live with a red dot; her mention of Alex in #duyurular lights the bell (1) and the channel badge; the bell lists it and opens the channel, clearing the count; "Dana Developer yazıyor…" appears under Alex's composer and disappears after 6 seconds (the first signal of the session did not show; the next three did); Alex sets "Kod yazıyor" in the status dialog and Dana's stream receives it |
| Screenshot 1440×900 | People list with status dots and lines, bell in the top bar |

Not verified: operating-system notifications (the browser pane cannot grant the
permission; the code path is the standard Notification API, which Electron supports),
and running the Go tests with the race detector (no C compiler in the WSL environment).

### Increment 2.3 (threads, reactions, mentions, pins)

| Check | Result |
| --- | --- |
| `pnpm check:api` | 66 Go tests pass. New: replies stay out of history and unread counts while roots carry a summary; one-level threads within the channel; deleting a root with replies leaves a placeholder that goes with the last reply; mentions resolve to workspace members only and follow edits; reactions are per person, grouped in first-use order, validated as emoji (skin tones, flags and keycaps accepted; text rejected) and capped at 20 kinds; any member pins and unpins; non-members cannot react or pin; reply, thread-summary and reaction events; previews never cut a mention token |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 31 Vitest tests (new: mention token round trip, mention query, previews) |
| Browser, two users | Dana's thread reply with an @mention of Alex appears inline under its root; Alex replies from the thread panel choosing Dana from the "@" suggestions (stored as a token, shown as a name); Dana's reaction appears live in the thread and the inline preview; the quick 👍 in the toolbar; "Mesaja git" jumps to and highlights the pinned message |
| Screenshots 1440×900 | Channel with pinned bar, reactions and inline reply; thread panel |

### Increment 2.2 (direct messages)

| Check | Result |
| --- | --- |
| `pnpm check:api` | 62 Go tests pass. New: find-or-create in any order of people; conversations stay out of channel lists; they reach other people with the first message and sort by latest activity; outsiders get 404; fixed membership (leave, add, rename rejected); moderators cannot delete in conversations; notes to self; 9-person limit and unknown people rejected; guests only write to people they share a channel with; events reach participants only and stop when someone leaves the workspace |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 28 Vitest tests (new: conversation naming) |
| Browser, two users | Dana's one-to-one and group messages appear in Alex's sidebar and inbox without reload, with unread badges (sidebar, inbox, "Mesajlar"); Alex's reply reaches Dana's list as the newest; "Mesaj gönder" on a profile card opens the conversation |
| Screenshots 1440×900 | Inbox and group conversation |

### Increment 2.1 (channels)

Last run: 2026-10-30, Windows 11 with the API and PostgreSQL 17 in WSL2.

| Check | Result |
| --- | --- |
| `pnpm check:api` | 59 Go tests pass. New: default channel and guest restrictions; channel creation, validation and name normalization; public preview and joining; history paging; unread counts and read marker; author-only edits; moderator deletes with audit record; private channels hidden from non-members including the owner; cross-workspace isolation; live events reach members on every device, not non-members, stop at once after removal from a channel or the workspace, report member counts, and end at sign-out; hub unit tests (addressing, slow-consumer drop, session close) |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 27 Vitest tests (new: channel-name preview, message parsing, grouping) |
| Browser, two users | Dana's messages appear in Alex's open channel without reload; unread badge on another channel, cleared on opening it with a "new messages" divider; sidebar picks up new channels live; send, ↑-edit and delete from the UI |
| Screenshots 1440×900 | Channel page (light and dark), create-channel and browse dialogs match mockup "Yeni 04" |

Not yet verified (all of Phase 2): the event stream through Caddy in the production
Compose stack with TLS, and more than one API replica (not supported yet, ADR-0008).
The web layout targets desktop widths; narrow and mobile layouts are not built yet.
