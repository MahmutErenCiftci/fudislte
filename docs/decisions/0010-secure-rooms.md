# ADR-0010: Secure rooms as channels with expiring admissions

Status: Accepted · Phase 3

## Context
Teams need rooms for sensitive topics — incident response, management, HR — that are
locked with a password and/or limited to named people. The roadmap's rule: a password
must never bypass authorization, and losing access must take effect everywhere
(messages, files, live events, later media) at once. FUDISLTE has no account passwords
(ADR-0006); room passwords are the only passwords it stores.

## Decision
- A room is a channel of kind `room` with an access mode: `open` (everyone with
  `rooms.join`), `protected` (everyone with `rooms.join`, plus the password) or
  `restricted` (only people on the room's access list, optionally plus a password).
  Everything built for channels — messages, threads, reactions, files, search,
  notifications, live events — therefore works in rooms unchanged.
- **Being in `channel_members` is being admitted.** A password admission has an
  `expires_at` (15 minutes to 30 days, default 12 hours). Every membership query ignores
  expired rows, so expiry is exact without waiting for a job; a job removes expired rows
  every 30 seconds and sends `channel.left`, so open clients lock at once.
- Order of checks when entering: the room must be visible to the caller (otherwise 404);
  the caller must be allowed to enter (otherwise 403 for managers who may only see it);
  only then is the password checked. A right password from someone not allowed is
  refused like any other request.
- Passwords are hashed with Argon2id (`golang.org/x/crypto/argon2`, BSD-3-Clause;
  19 MiB, 2 passes, 1 lane, 16-byte salt), stored in PHC format with their parameters.
  At most four hashes run at once, which bounds memory. Guesses are limited to five per
  person and room, then one a minute; every wrong guess is audited.
- Any change of access mode or password ends every admission except the creator's.
  Managers can also end one person's admission or edit a restricted room's access list;
  people taken off the list leave at once.
- `rooms.manage` (Owner, Administrator, Security Administrator) manages every room's
  settings but **does not admit**: managers see names, modes and who is inside, never
  messages or files, unless they are admitted like anyone else. The creator manages
  their room and enters without the password they set.

## Consequences
- Revocation reaches messages, files, search, notifications and live events through the
  same membership check; Phase 4 media tokens must be capped at the admission's expiry
  and revoked when it ends.
- Room passwords are shared secrets: rotating them is the way to keep out someone who
  knows one. The UI says so.
- The attempt limiter is per API process (like the other limiters); several replicas
  need a shared limiter (ADR-0008).
