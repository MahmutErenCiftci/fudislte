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
  languages; desktop installers (code signing needs the organization's certificate).
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
- **Operations:** backup, restore and restore-drill scripts with checksum verification;
  a load-test tool and measured capacity.

### Preview

- **AI worker** (`services/ai`): summaries with cited sources, permission-aware search,
  transcription and agents that need approval for destructive actions. The API does not
  use it yet; FUDISLTE works fully without it.
- **VS Code presence extension** (`extensions/vscode`): shares an opted-in "coding"
  status. It needs personal access tokens, which the API does not issue yet.
