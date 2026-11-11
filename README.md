# FUDISLTE

[![License: PolyForm Internal Use 1.0.0](https://img.shields.io/badge/license-PolyForm%20Internal%20Use%201.0.0-blue.svg)](LICENSE)

A source-available, self-hosted alternative to Discord, Slack and Microsoft Teams — **simple on
the surface, powerful underneath.** Chat, voice and video rooms, meetings, projects and
whiteboards on your own server: no vendor cloud, no per-seat fee, your data stays with
you. The interface is in Turkish and English.

## Features

- **Messaging:** public and private channels, direct and group messages, threads,
  reactions, mentions, pins, presence and status, typing indicators, notifications, file
  attachments with previews, message search, channel archiving and message retention.
- **Secure rooms:** open, password-protected and restricted rooms with expiring
  admissions; a password never replaces authorization, and revoking access ends it
  everywhere at once.
- **Voice and video:** persistent voice rooms, video, screen sharing, push to talk,
  per-person volume, moderation, and scheduled meetings with calendar invitations —
  through a self-hosted [LiveKit](https://livekit.io) server.
- **Projects:** Kanban (drag and drop, also by keyboard), list and calendar views,
  sprints, editable workflows, labels, assignees, checklists, comments, activity, and
  tasks linked to rooms.
- **Whiteboards:** [Excalidraw](https://excalidraw.com) boards that several people edit
  at once with live cursors; every asset is served by your own server.
- **Accounts and security:** passwordless sign-in with one-time codes sent to the work
  email, roles and permissions, company email domains verified through DNS, invitations,
  single-use access keys that IT prepares so people get straight in, a session lifetime
  IT sets for everyone (48 hours by default), audit log, account disable, strict
  isolation between workspaces ([threat model](docs/security/threat-model.md)).
- **No phoning home:** a server reports nothing unless an administrator opts in to
  registering it with the project — then only its organization name, a contact email,
  its number of users and its version ([what is sent](docs/deployment/registry.md)).
- **Clients:** a web app and an Electron desktop app for Windows, macOS and Linux.
- **Operations:** Docker Compose deployment with automatic HTTPS, backup and restore
  scripts with verified restore drills, and [measured capacity](docs/architecture/load-testing.md).

## Status

Version 0.1.0, complete through roadmap phase 5: foundation, accounts,
messaging, secure rooms, voice and video, projects and whiteboards. Developer features,
knowledge base, AI integration and hardening follow — see the [roadmap](docs/roadmap.md)
and the [changelog](CHANGELOG.md).

## Download

The desktop app for Windows, macOS and Linux is on the
[latest release](https://github.com/MahmutErenCiftci/fudislte/releases/latest). On first
launch, enter your organization's FUDISLTE address and sign in with your work email; the
same address also works in a browser without installing anything.

## Quick start

You need a Linux server with Docker Engine and the Compose plugin, a DNS name pointing at
it, and an SMTP relay (people sign in with codes sent by email).

```bash
git clone <repository URL> fudislte && cd fudislte/infrastructure/docker
cp .env.example .env
# Edit .env: FUDISLTE_DOMAIN, a strong POSTGRES_PASSWORD and the FUDISLTE_SMTP_* settings
docker compose up -d --build
docker compose logs api | grep setup_token
```

Open `https://<your domain>`, enter the setup token and your work email, then the code
that arrives, and create the first workspace. With [Claude Code](https://claude.com/claude-code),
run `claude` in the checkout on the server and ask it to install FUDISLTE: the
`install-fudislte` skill does all of this, tests email and sets up backups. Voice and video, private networks, backups
and upgrades: [docs/deployment/docker-compose.md](docs/deployment/docker-compose.md) and
[docs/deployment/backup-restore.md](docs/deployment/backup-restore.md).

## Development (Windows)

The Go API and PostgreSQL run inside WSL2. The frontend and desktop shell run on Windows.
(Windows Smart App Control blocks freshly compiled unsigned binaries, which WSL avoids.)

One-time setup:

```powershell
wsl --install -d Ubuntu-24.04 --no-launch
wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/provision.sh   # Go + PostgreSQL 17
pnpm install
```

Run (three terminals):

```powershell
pnpm dev:api        # API on http://localhost:8080; prints the setup token and, in development,
                    # every email (sign-in codes, invitations) instead of sending it
pnpm dev:web        # Web app on http://localhost:5173
pnpm dev:desktop    # Desktop shell pointed at the dev server
```

On macOS or Linux, install Go 1.27 and PostgreSQL 17 locally and run the scripts under
`scripts/wsl/` directly with bash.

The whole stack also runs in Docker inside WSL, without Docker Desktop:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/install-docker.sh   # once: Docker Engine inside WSL
wsl -d Ubuntu-24.04 -- bash scripts/wsl/docker-local.sh up          # http://localhost:8088
wsl -d Ubuntu-24.04 -- bash scripts/wsl/docker-local.sh codes       # sign-in codes (no SMTP locally)
```

## Checks

```powershell
pnpm check:api      # gofmt, go vet, unit + PostgreSQL integration tests
pnpm typecheck      # all TypeScript packages
pnpm test           # Vitest suites
pnpm --filter @fudislte/web build
pnpm --filter @fudislte/desktop smoke   # launches Electron against the dev server and checks the sandbox
```

The AI worker has `scripts/wsl/ai-test.sh`, the VS Code extension `npm test` in
`extensions/vscode`. CI runs all of them ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Repository

```
apps/web            React web app (also rendered by the desktop shell)
apps/desktop        Electron shell
services/api        Go API (modular monolith) + PostgreSQL migrations
services/ai         Optional AI worker (Python, FastAPI)
services/registry   Project registry for opt-in server registrations (Go, standard library only)
packages/ui         Design tokens and UI components
packages/api-client Typed API client
packages/platform   Web/desktop capability abstraction
extensions/vscode   VS Code presence extension (needs personal access tokens)
infrastructure/     Docker Compose deployment
docs/               Architecture, decisions, security, deployment
scripts/            Development helpers; scripts/ops: backup, restore, restore drills, load tests
tools/loadtest      Load generator (Go, standard library only)
website/            Public landing page (static HTML/CSS/JS for Cloudflare Pages)
```

## Documentation

- Architecture, phase by phase: [docs/architecture](docs/architecture) — start with
  [phase-1.md](docs/architecture/phase-1.md)
- Decisions (ADRs): [docs/decisions](docs/decisions)
- Security: [threat model](docs/security/threat-model.md) and [SECURITY.md](SECURITY.md)
- Deployment: [Docker Compose](docs/deployment/docker-compose.md),
  [backups and restore](docs/deployment/backup-restore.md)
- Design and interface: [docs/design](docs/design/README.md)
- Dependencies and their licenses: [docs/dependencies.md](docs/dependencies.md)
- Releasing: [docs/releasing.md](docs/releasing.md)
- Privacy and terms: [PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md)

## Contributing

Contributions are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md). Contributors agree
to the [Contributor License Agreement](CLA.md) once, on their first pull request. Report
security problems privately as described in [SECURITY.md](SECURITY.md).

## License

FUDISLTE is **source-available, not open source**. It is licensed under the
[PolyForm Internal Use License 1.0.0](LICENSE) by Mahmut Eren Çiftçi
([NOTICE](NOTICE), [ADR-0016](docs/decisions/0016-source-available-polyform-internal-use.md)).
In plain words — the license text is what counts:

- **You may** install and run FUDISLTE free of charge for the internal business operations
  of you and your company, with as many users as you like, and change your own
  installation.
- **You may not** distribute it: no copies for others, no published forks or modified
  versions, no selling it, no hosting it for other organizations.
- **Anything else** — personal use, hosting for customers, redistribution — needs written
  permission from the licensor; open an issue or contact the repository owner.

Container images, the web app (`/licenses.txt`) and the desktop installer carry the
notices of the third-party software they include.
