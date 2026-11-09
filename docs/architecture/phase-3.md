# Phase 3 Architecture — Secure Rooms

Status: **Done** — implemented and verified (see "Verification").

Rooms are spaces for sensitive topics, locked with a password and/or limited to named
people (mockup "Yeni 05"; voice arrives in Phase 4). Design decisions: ADR-0010.

## 1. Data model (migration 00009)

```
channels       + access (open|protected|restricted), password_hash (Argon2id, PHC),
                 password_changed_at, admission_minutes      -- rooms: kind = 'room'
channel_members + expires_at                                 -- NULL lasts
room_access    (channel_id, user_id), org_id, added_by, added_at
```

- A room is a channel of kind `room`, always `private`, with a free-text name of 1–60
  characters (unique per workspace, case-insensitive). Channel names keep their own
  unique index.
- Checks in the database: open rooms have no password, protected rooms have one,
  admission length is 15 minutes to 30 days.
- `room_access` references workspace membership, so leaving the workspace removes people
  from every access list.
- New permissions: `rooms.join` and `rooms.create` (every default role except Guest) and
  `rooms.manage` (Owner, Administrator, Security Administrator). `rooms.manage` is a
  management permission: email-domain join roles cannot carry it.

## 2. Access rules

| Who | Open | Protected | Restricted |
| --- | --- | --- | --- |
| Sees the room | `rooms.join` | `rooms.join` | People on the access list; the creator |
| Enters | Without password | With the password; admission expires | On the list, plus the password if set |
| Manages settings | Creator, `rooms.manage` | same | same |

- Not visible → 404, so a restricted room's existence is not disclosed. Room managers
  who may not enter get 403 on entering and can only manage settings.
- **A password never replaces authorization**: it is checked only after visibility and
  the access list. Guests (no `rooms.join`) are refused with the right password; so is
  anyone off a restricted room's list, owners included.
- Admitted people use the channel endpoints for messages, threads, reactions, pins, files
  and typing. Every membership query ignores expired admissions, so messages, files,
  search, notifications (including the unread count) and live events stop at the
  expiry, before the cleanup job (every 30 seconds) removes the row and tells clients.
- Changing the access mode or the password ends every admission except the creator's.
  Shortening the admission length shortens current admissions. Taking someone off a
  restricted room's list ends their admission at once.
- Channel endpoints that change membership or names answer 409 `room_managed` for rooms.

## 3. API (all under `/api/v1/orgs/{orgID}`)

| Method and path | Purpose |
| --- | --- |
| `GET /rooms[?all=true]` | Rooms the caller can enter; `all` (rooms.manage) lists every room's settings |
| `POST /rooms` | Create (`name`, `topic`, `access`, `password`, `admissionMinutes`, `memberIds` for restricted rooms) |
| `GET /rooms/{id}` · `PATCH /rooms/{id}` · `DELETE /rooms/{id}` | Read; rename, describe, change admission length; delete with messages and files |
| `PUT /rooms/{id}/security` | `access`, new `password` or `removePassword`; ends admissions |
| `GET`/`PUT /rooms/{id}/access` | A restricted room's access list (`userIds`, replaces it) |
| `POST /rooms/{id}/enter` · `POST /rooms/{id}/leave` | Enter (`password`); leave |
| `GET /rooms/{id}/members` · `DELETE /rooms/{id}/members/{userID}` | Who is inside with expiry; end one admission |

A room carries the caller's view: `admitted`, `admissionExpiresAt`, `canEnter`,
`needsPassword`, `canManage`, `allowed`, `unreadCount`. Wrong passwords answer 403
`wrong_password`; more than five guesses per person and room, then one a minute, answer
429. Events: `room.updated`; `channel.joined`, `channel.left` and `channel.members`
carry room IDs too.

Audit: `room.created`, `room.updated`, `room.security_changed` (access from/to, password
changed, admissions ended), `room.access_changed` (added, removed), `room.entered`
(protected and restricted rooms), `room.password_failed`, `room.admission_ended`,
`room.deleted`.

## 4. Client

- "Odalar" in the main navigation (with the unread total of admitted rooms) opens the
  rooms page: cards with access badge, description, people inside and the caller's
  admission ("Erişim 11 saat sonra bitiyor"), and "Oda oluştur" (rooms.create).
- The create dialog picks the access mode (three cards), password with confirmation,
  admission length and, for restricted rooms, the people who may enter.
- A room's page follows the mockup's header: icon, name, access badge, people inside,
  admission time, description, copy-link and a menu (settings, leave, delete). Below it,
  the channel conversation (chat and files tabs) is reused unchanged.
- People not admitted see a lock screen: password field (protected), "Odaya gir" (open
  and restricted without password) or, for managers off the list, an explanation and
  the settings. When an admission ends — expiry, new password, removal — the open page
  returns to the lock screen at once and cached messages are dropped.
- Room settings: General (name, description, admission length), Security (access mode,
  new password, warning that admissions end), People (who is inside, end admission;
  access list for restricted rooms). *Settings → Odalar* lists every room for
  `rooms.manage` holders. Search, notifications and the command palette include rooms.

## 5. Verification

Run 2026-10-30, Windows 11 with the API and PostgreSQL 17 in WSL2.

| Check | Result |
| --- | --- |
| `pnpm check:api` | 79 Go tests pass. New: Argon2id hashing (salted, verification, malformed and oversized parameters rejected, password policy); rooms: validation, unique names, rooms kept out of the channel list, contents unreadable before entering, wrong password refused and audited, admission with a 12-hour expiry; **exit criterion — a guest with the right password gets 404, someone off a restricted room's list gets 404, the owner and a security administrator off the list get 403**; search follows admission; managers list every room but cannot read it; channel endpoints answer `room_managed`; rotating the password ends admissions at once (live `channel.left`, history 404, files 404, no further events), the old password fails and the new one works; an expired admission is refused before the cleanup job runs; managers end one admission; removing someone from the access list ends theirs; guess limit (429 after five); audit entries; deleting a room removes its files; open rooms, protecting an open room ends admissions, shorter admission lengths apply to current admissions, leaving |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 38 Vitest tests (new: admission lengths) |
| Browser (Alex) with Dana via the API | Rooms page lists an open and a protected room; the lock screen refuses a wrong password with "Şifre doğru değil."; the right one opens the room with Dana's message and "Erişim 12 saat sonra bitiyor"; Alex's message is sent; when Dana changes the password the open page returns to the lock screen without reload; *Settings → Odalar* and the audit log show the room events in Turkish |
| Cleanup job (dev stack) | An admission set to expire one second ago is gone from `channel_members` within 35 seconds |

Not verified: several API replicas (the attempt limiter is per process).
