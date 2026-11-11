# Changelog

Notable changes to FUDISLTE. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/); while the version is 0.x,
anything may change between minor versions.

## [0.1.0] — unreleased

First public version, source-available under the PolyForm Internal Use License 1.0.0.

### Added

- **Foundation:** first-run setup, passwordless sign-in with one-time codes sent to the
  work email, workspaces with roles and permissions, company email domains verified
  through DNS, emailed invitations, member directory, sessions, audit log, Turkish and
  English interface, web app and Electron desktop shell, Docker Compose deployment with
  automatic HTTPS.
- **Accounts:** administrators disable and re-enable accounts; HTML emails in both
  languages; desktop installers for Windows, macOS and Linux, built and published with every release.
- **Access keys and session lifetime:** IT prepares an account (email, name, role,
  language) and hands the person a single-use key; entering it on the sign-in page opens
  the account without an email code. Keys only create new accounts, and workspace
  administrators may only create them for the workspace's verified domains. Sign-ins
  last 48 hours by default; instance administrators change this for everyone in
  *Settings → Security* (it replaces `FUDISLTE_SESSION_TTL`).
- **Guided installation:** the `install-fudislte` Claude Code skill installs FUDISLTE on a
  server from start to finish, backed by `scripts/install/` (preflight checks, `.env`
  with generated secrets, post-start verification).
- **Opt-in registration:** with an administrator's consent (an unchecked box at setup, or
  *Settings → Security*), a server reports its organization name, a contact email, its
  number of users and its version to the project once a day; turning it off withdraws
  the record. `services/registry` receives the reports and lists them on a
  password-protected page ([docs/deployment/registry.md](docs/deployment/registry.md)).
- **Messaging:** public and private channels, direct and group messages, threads,
  reactions, mentions, pins, presence and status, typing indicators, notifications, file
  attachments with previews, message search, channel archiving, workspace message
  retention.
- **Secure rooms:** open, password-protected and restricted rooms with Argon2id passwords
  and expiring admissions; revoking access ends it for messages, files and live events.
- **Voice and video:** persistent voice in rooms through a self-hosted LiveKit server,
  video, screen sharing with a source picker in the desktop app, push to talk, per-person
  volume, moderation, and scheduled meetings with calendar invitations.
- **Projects and whiteboards:** public and private projects with a Kanban board (drag and
  drop, also by keyboard), list and calendar views, filters, assignees, checklists,
  comments and activity, sprints, editable workflows and labels, tasks linked to rooms;
  Excalidraw whiteboards that several people edit at once with live cursors, served
  entirely by your own server.
- **Privacy and terms:** [PRIVACY.md](PRIVACY.md) (KVKK and GDPR notice for the website,
  the desktop app and the opt-in registry) and [TERMS.md](TERMS.md); the desktop installer
  shows the license terms before installing.
- **Operations:** backup, restore and restore-drill scripts with checksum verification;
  a load-test tool and measured capacity.


### Security

Found by a security review before the first release and fixed:

- **Access keys** need *Manage members* instead of *Invite members*: a key replaces proof
  of owning the mailbox, so a team leader could prepare a colleague's account and sign in
  as them. A key stops working when its domain is no longer verified, and creating one no
  longer reveals whether an address outside the workspace has an account.
- **Role assignment** also checks permissions, not only rank: nobody can give a role that
  grants permissions they do not hold.
- **Invitations:** at most 3 code emails per invited address every 10 minutes (as for
  sign-in), a cap on invitation emails per person, and invitation tokens no longer
  appear in the request log.
- **Secure rooms:** a room's creator keeps password-free entry only while their role may
  use rooms, and loses it when they leave the workspace; people with *Manage rooms* can no
  longer add themselves to a restricted room's access list; admissions end as soon as a
  role loses *Join rooms*.
- **Whiteboards:** a board's stored size is capped at 32 MiB, deleted shapes included
  (the oldest deletions make room first), so one editor can no longer make opening a
  board exhaust the server's memory; shape versions can no longer be set so high that no
  later edit replaces them; a person's open board windows are capped; links on shapes
  that point elsewhere open outside the app instead of replacing it.
- **Uploaded files** keep the API's sandbox Content-Security-Policy in production (Caddy
  replaced it).
- **Desktop app:** screen sharing goes through the app's own picker window; the server's
  page no longer sees the list of windows and their thumbnails or picks for the person.
  Spellcheck no longer downloads dictionaries on Linux, and file:// gets no extra
  privileges.
- **Limits:** at most 32 live event streams per account, and room-password hashing is
  rate limited per person.
- **Retention** also removes the files of a files-only thread root that keeps getting
  replies; expired room admissions no longer let guests start direct messages.
- **Backups** are encrypted unless `--unencrypted` is given; the install skill no longer
  creates the decryption key on the server, and the manual commands write no plaintext.
- **Registry:** servers silent for 30 days are deleted, new registrations are limited
  per network, and every CSV column is protected against formula injection.
- **Deployment:** the web container runs read-only without capabilities; GitHub Actions
  are pinned to commit SHAs; Go 1.27.4 (fixes GO-2026-6859, an HTTP server crash);
  patched versions of Excalidraw's nanoid, lodash-es and KaTeX dependencies; the
  preflight check no longer passes its SMTP argument to a shell; scripts no longer use
  guessable /tmp paths; Docker is installed from its package repository instead of
  `curl | sh`.

Database migration: `00018_board_element_size` adds the size of every whiteboard
element, computed once for existing boards.
