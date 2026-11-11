# Phase 4 Architecture — Voice & Video

Status: **Done** — voice, video and screen sharing in rooms (4.1, 4.2) and scheduled
meetings (4.3) implemented and verified.

Voice rooms follow mockup "Yeni 05" (participants with speaking state, microphone,
headphones, screen share, leave). Media goes through a self-hosted LiveKit server; the
API decides who may connect (ADR-0011).

| Increment | Scope | Status |
| --- | --- | --- |
| **4.1 Voice in rooms** | LiveKit tokens for admitted people, voice panel, persistent connection with a sidebar dock, mute, deafen, push to talk, per-person volume, microphone choice, moderation, revocation | Done |
| **4.2 Video and screen sharing** | Camera and screen share tiles, desktop source picker, microphone/camera/screen permissions in the desktop shell | Done (desktop picker not exercised by hand) |
| **4.3 Meetings** | Scheduled meetings with invitations | Done |

## 1. Media path

```
browser / desktop ──wss /livekit (signalling, via Caddy)──▶ LiveKit :7880
        └──── media: UDP 7882 · TCP 7881 · TURN UDP 3478 ────▶ LiveKit
API ──Twirp RoomService (admin token)──▶ LiveKit        LiveKit ──signed webhooks──▶ API
```

- The API signs LiveKit tokens (HS256 with the configured key and secret) only for
  people admitted to the room: `POST /rooms/{id}/voice`. Grants: join that room,
  subscribe, publish microphone, camera, screen share and its audio, data messages. The
  token expires with the admission (at most six hours).
- Configuration: `FUDISLTE_LIVEKIT_URL` (what clients connect to; empty disables voice),
  `FUDISLTE_LIVEKIT_API_URL` (how the API reaches LiveKit), `FUDISLTE_LIVEKIT_API_KEY`,
  `FUDISLTE_LIVEKIT_API_SECRET` (at least 32 characters).

## 2. Access and revocation

- Only admitted people get a token (`403 not_admitted` otherwise; people who may not see
  the room get 404). Without LiveKit settings the endpoints answer `503 media_unavailable`.
- Ending an admission — new password, access mode, access list, a manager ending it,
  expiry, deleting the room — disconnects the person from LiveKit at once
  (`RemoveParticipant`). The admission job (every 30 s) also lists every FUDISLTE LiveKit
  room and removes anyone not admitted or whose account is disabled, which covers
  removed workspace members and anything else.
- LiveKit's `participant_joined` webhook is checked against the same rule; webhooks
  without a valid signature (JWT signed with the API secret, carrying the SHA-256 of the
  body) are refused with 401.
- Room managers (creator, `rooms.manage`) mute a participant's microphone
  (`POST /rooms/{id}/voice/{userID}/mute`) or remove them from voice
  (`DELETE /rooms/{id}/voice/{userID}`); both are audited (`room.voice_muted`,
  `room.voice_removed`). Removal does not end the admission.

## 3. API and events

| Method and path | Purpose |
| --- | --- |
| `POST /orgs/{orgID}/rooms/{id}/voice` | LiveKit `{url, token, expiresAt}` for an admitted person |
| `GET /orgs/{orgID}/rooms/{id}/voice` | `{enabled, participants:[{userId, displayName, muted, camera, screenShare}]}` for admitted people and managers |
| `POST …/voice/{userID}/mute` · `DELETE …/voice/{userID}` | Moderation (room managers) |
| `POST /api/v1/media/webhook` | LiveKit webhooks (signature checked) |

Event `voice.updated` `{orgId, roomId, participants}` goes to the room's members when
someone joins, leaves, mutes or starts a camera or screen share, so the "N kişi seste"
line stays current for people not connected.

## 4. Client

- One LiveKit connection per window lives in a store outside the pages
  (`features/voice/voice.ts`), so voice continues while people move between pages; the
  sidebar dock shows the room, microphone, headphones and leave on every page. Ending
  an admission (`channel.left`) leaves voice too.
- The room page shows a voice strip ("Sesli sohbet · 2 kişi seste", avatars, "Sese
  katıl"); once connected, participants as in the mockup (speaking ring, muted badge,
  "Konuşuyor / Dinliyor / Sessizde"), camera and screen tiles, and the control bar:
  microphone with device choice and push to talk (Ctrl+Space, remembered per device),
  headphones (deafen also mutes the microphone), camera, screen share, leave.
- Clicking a participant opens their volume (0–100 %, remembered per person and device)
  and, for room managers, mute and remove.
- Without microphone permission people still join and listen. When the browser blocks
  audio autoplay, a banner asks for a click.
- Desktop: the shell grants `media` (microphone, camera) and `display-capture` only to the
  connected server; screen sharing opens the app's own picker window with screens and
  windows and their thumbnails (system audio with whole screens on Windows); the page
  never sees that list; cancelling shares nothing.

## 5. Deployment

- Production: `COMPOSE_PROFILES=media` starts LiveKit (`livekit/livekit-server:v1.9.4`)
  with UDP 7882, TCP 7881 and TURN UDP 3478 published; Caddy proxies `/livekit/*` to it;
  `Permissions-Policy` allows camera, microphone and display capture for the site
  itself. See docs/deployment/docker-compose.md.
- Development: `bash scripts/wsl/dev-livekit.sh` runs LiveKit in WSL's Docker on the
  host network, generates keys into `~/.config/fudislte/livekit.env` (outside the
  repository) and advertises the WSL VM address for media, which Windows reaches
  directly; `scripts/wsl/dev-env.sh` hands the keys to the API.

## 6. Verification (4.1 and 4.2)

Run 2026-10-30, Windows 11, API and LiveKit 1.9.4 in WSL2.

| Check | Result |
| --- | --- |
| `pnpm check:api` | 85 Go tests pass. New: LiveKit tokens carry identity, name, room, publish sources and expiry, and fail with another secret or tampered payload; the RoomService client lists, removes (absent participant is fine) and mutes; webhook signature and body hash checks. Rooms: only admitted people get a token, expiring with the admission; guests get 404; participants listed; managers mute and remove (non-managers 403); an unadmitted participant reported by a webhook is removed and members get `voice.updated`; unsigned webhooks get 401; changing the password disconnects voice at once |
| `pnpm typecheck` · `pnpm test` · web build | Pass (38 Vitest tests); desktop permission tests updated (9 pass) |
| API against real LiveKit | `GET /rooms/{id}/voice` and token issuance work against the dev LiveKit (Twirp calls answered 200) |
| Two people, real LiveKit | Two headless Edge instances with fake microphone and camera (Alex and Dana) joined the same room through the UI: each saw the other with live "Konuşuyor" changes, Dana's camera appeared as a video tile for Alex, and the test tone was audibly played back on this machine (audio path end to end). The first attempt failed because LiveKit advertised 127.0.0.1 for media; the dev script now advertises the WSL VM address |
| Production config | `docker compose config` with the media profile; LiveKit 1.9.4 starts with the production settings (read-only, no capabilities) and discovers its public IP |

Not verified: the Electron screen-share picker and permissions by hand, screen sharing in
a browser, push to talk, deafen, per-person volume and microphone switching by hand,
moderation from the UI (the API is covered by tests), TURN through a restrictive
network, and LiveKit behind Caddy with TLS.

## Meetings (4.3)

Scheduled voice and video meetings with email invitations: mockup "Yeni 06" for the
meeting and the "Yaklaşan toplantılar" card of "Yeni 03" on the home page. The AI notes,
transcript and summary of "Yeni 06" belong to Phase 8.

### Data model (migration 00011)

```
meetings          id (UUIDv7), org_id, title (1–120), agenda (≤ 2000), starts_at,
                  duration_minutes (15–480), time_zone (the organizer's IANA zone),
                  organizer_id, sequence, created_at, updated_at, canceled_at
meeting_invitees  (meeting_id, user_id), org_id, added_at
```

- `(org_id, organizer_id)` references memberships with `ON DELETE SET NULL (organizer_id)`:
  a meeting outlives its organizer leaving the workspace, and then nobody can edit or
  cancel it. Invitees reference `meetings (id, org_id)` and memberships (cascade), so an
  invitation never crosses workspaces and leaving the workspace ends it.
- `sequence` is the iCalendar SEQUENCE: it grows with every new time or length and with
  the cancellation. Start times are stored to the minute.
- New permission `meetings.create` for every default role except Guest (existing roles
  backfilled). Anyone may be invited, guests included: the invitation is the only right
  needed to see and join a meeting.

### Access rules

| Who | Sees and joins | Edits, cancels, moderates |
| --- | --- | --- |
| Organizer | Yes | Yes |
| Invitees | Yes | No (403) |
| Anyone else, workspace owners included | 404 | 404 |

- The join window runs from 15 minutes before the start until 2 hours after the scheduled
  end. Outside it `POST /meetings/{id}/voice` answers 409 `meeting_not_started` or
  `meeting_ended`, and 409 `meeting_canceled` once canceled; inside it the LiveKit token
  names the room `fudislte-meeting-<id>` and expires when the window closes.
- A start must lie between now (with 5 minutes of slack) and a year ahead, checked only
  when the time changes, so past meetings keep an editable agenda. At most 200 invitees.
- Revocation follows the room rules. Canceling, taking someone off the list or moving the
  meeting out of its window disconnects whoever may no longer be in the call right after
  the change commits. The 30-second sweep and the `participant_joined` webhook apply the
  same rule to every `fudislte-meeting-<id>` room (organizer and invitees with active
  accounts, not canceled, inside the window), next to the admission rule for
  `fudislte-<roomID>` rooms. `server.Deps.SweepEvery` lets tests shorten the interval.
- Creating, changing and canceling are limited per person (20 at once, then one every
  3 seconds): each may email every invitee.

### API (under `/api/v1/orgs/{orgID}`)

| Method and path | Purpose |
| --- | --- |
| `GET /meetings?range=upcoming\|past` | The caller's meetings (organizer or invitee): not yet ended, soonest first; or ended, latest first; at most 100. Canceled meetings stay listed |
| `POST /meetings` | `title`, `agenda`, `startsAt`, `durationMinutes` (default 30), `inviteeIds`, `timeZone` (meetings.create) |
| `GET /meetings/{id}` · `PATCH /meetings/{id}` · `DELETE /meetings/{id}` | Read; change (organizer; absent fields stay, `inviteeIds` replaces the list); cancel (organizer; answers the canceled meeting) |
| `GET /meetings/{id}/voice` · `POST /meetings/{id}/voice` | Who is in the call; a LiveKit `{url, token, expiresAt}` inside the window |
| `POST …/voice/{userID}/mute` · `DELETE …/voice/{userID}` | Moderation (organizer), audited as `meeting.voice_muted` and `meeting.voice_removed` |

A meeting carries `endsAt`, `opensAt`, `closesAt`, `organizer` (null after they left),
`invitees` (by name) and the caller's `isOrganizer`. Events: `meeting.updated {orgId,
meetingId}` goes to the organizer and the invitees — and to people just taken off the
list — on create, change and cancel; `voice.updated` for a meeting carries `meetingId`
instead of `roomId`. Audit: `meeting.created`, `meeting.updated` (title, new time and
length, agenda changed, people added and removed), `meeting.canceled`.

### Email invitations

- Sent through the outbox to invitees with active accounts, each in their own language
  (`users.locale`, else the request's): the invitation when the meeting is created and
  to people added later; "Updated" to everyone else when the time or length changes;
  "Canceled" on cancel; "No longer invited" to people taken off the list. Title and agenda
  changes alone send nothing.
- Text and HTML show the meeting, its time in the organizer's time zone ("3 Kasım 2026
  Salı, 12:00–13:00 (Europe/Istanbul)"), the organizer, the agenda and the link
  `/w/<slug>/m/<id>`.
- Each email carries an iCalendar file (RFC 5545 and 5546): `METHOD:REQUEST` (invite.ics)
  or `METHOD:CANCEL` with `STATUS:CANCELLED` (cancel.ics), `UID:<meetingID>@<public
  host>`, the current `SEQUENCE`, times in UTC (`…Z`) so calendars show local time, the
  link as location, the organizer, and the recipient as the only attendee — other
  invitees' addresses are not disclosed.
- `mail.Message` has attachments: with any, the SMTP message is `multipart/mixed` with the
  `multipart/alternative` text first and base64 files after; without, it is unchanged.

### Client

- "Toplantılar" in the main navigation after "Odalar", for everyone (guests can be
  invited); a meeting page keeps it highlighted.
- The meetings page has "Yaklaşan" and "Geçmiş" tabs: cards with a calendar tile, date and
  time range in the viewer's language and time zone, status ("Birazdan", "Şimdi", "İptal
  edildi"), agenda, organizer and invitee avatars, and "Katıl" while the window is open,
  which connects and opens the meeting. "Toplantı oluştur" needs meetings.create.
- One dialog creates and edits: title, date, start, duration (15 minutes to 8 hours),
  invitees (member picker, needs members.view) and agenda; it sends the browser's time
  zone.
- The meeting page: header with title, status, date, time range and duration,
  participant count, organizer, copy link and, for the organizer, edit and cancel; the
  call panel with the reason when it is closed ("Görüşmeye … itibarıyla katılabilirsin",
  ended, canceled); the agenda; participants with who is in the call.
- The voice store, panel and sidebar dock work on a target `{kind: room|meeting, id, name,
  orgId, slug}`; the dock links to `/r/:id` or `/m/:id`. Rooms behave as before.
- Home: "Yaklaşan toplantılar" with the next three meetings that are not canceled (times,
  title, people, "Katıl" while open), shown only when there are any.
- `meeting.updated` refetches the meeting lists and the open meeting; so does a
  reconnected event stream.

### Verification (4.3)

Run 2026-10-30, Windows 11, API and PostgreSQL 17 in WSL2.

| Check | Result |
| --- | --- |
| `pnpm check:api` | 96 Go tests pass (10 new). Meetings: validation (title, agenda, past or too distant start, length, time zone, people outside the workspace); guests cannot create; only the organizer and invitees see a meeting (others and the owner 404, another workspace 404 and its members cannot be invited); invitations in each invitee's language with an `.ics` REQUEST (UID, SEQUENCE 0, UTC times), none to the organizer; a title change sends kept invitees nothing; a new invitee gets the invitation, a removed one a CANCEL and `meeting.updated`; a new time sends updates with SEQUENCE 1; cancel sends CANCEL with SEQUENCE 2 and blocks changes (409); audit entries. Calls: 409 `meeting_not_started` before the window, a token for `fudislte-meeting-<id>` expiring when the window closes inside it, 409 `meeting_ended` after it, 404 for people not invited; participants; organizer mute and remove (invitees 403); a stranger reported by the webhook is removed, an invitee is not, invitees get `voice.updated` with `meetingId`; taking someone off the list and canceling disconnect at once; a guest invitee joins; the meeting outlives its organizer leaving and drops an invitee who leaves; the sweep removes strangers from meeting and room calls and empties a meeting once its window closes. Mail: `multipart/mixed` with the nested alternative and a base64 attachment, header injection through file names refused; calendar escaping, 75-octet folding without splitting UTF-8, cancellations; meeting templates in Turkish and English with escaped HTML |
| `pnpm typecheck` · `pnpm test` · web build | Pass; 46 Vitest tests (new: meeting phases and the join window, date and time inputs, default start, durations, time ranges, dock links, meeting API paths) |

| Browser and real LiveKit (lead, after applying 00011) | Alex schedules "Sprint Planlama" with Dana: the invitation email is written in Turkish with the time in the organizer's zone; *Toplantılar* lists it as "Birazdan" with "Katıl"; the meeting page shows time, organizer, invitees and agenda; Dana (camera on) and Alex join "Toplantıya katıl" through LiveKit and each sees the other with Dana's video tile; Alex cancels: Dana's page shows "Bu toplantı iptal edildi. Toplantının görüşmesinden çıkarıldın.", the call is empty and the cancellation email is written |

Not verified: the create dialog, editing and the home card by hand; delivery through a
real SMTP server and how Outlook, Gmail and Apple Calendar import the `.ics` files;
several API replicas (the rate limit is per process).
