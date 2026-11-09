# Deploying FUDISLTE with Docker Compose

The stack is three containers: **Caddy** (TLS, the web app, reverse proxy), the **API**
and **PostgreSQL**. Two optional parts join the same Compose project: **LiveKit** for
voice and video (the `media` profile) and the **AI worker** (the `compose.ai.yml`
overlay, a preview). Live events come from the API itself
([ADR-0008](../decisions/0008-realtime-delivery.md)) and attachments live on the API's
volume ([ADR-0009](../decisions/0009-file-storage.md)), so nothing else is needed.

> Verification status (2026-11-03): the images were built from the repository and run on
> Docker Engine in WSL2 (Ubuntu 24.04) with the local override: first-run setup, sign-in,
> a whiteboard under the production Content Security Policy, the license pages, and a
> backup restored into a fresh project (`scripts/ops/restore-drill.sh`). Not
> yet run on a public server with a real domain, Let's Encrypt and SMTP — try a staging
> server first.

## Deployment profiles

| Profile | Users | Server (Phase 1) | Notes for later phases |
| --- | --- | --- | --- |
| Small | 5–50 | 2 vCPU, 4 GB RAM, 40 GB SSD | Voice for ~25 concurrent participants needs 4 vCPU and ≥100 Mbit/s symmetric |
| Medium | 50–500 | 4–8 vCPU, 16 GB RAM | Run LiveKit on its own host; managed or dedicated PostgreSQL |
| Large | 500+ | Several API replicas behind a load balancer | Redis for rate limits and sessions cache; LiveKit cluster; GPU host for optional AI |

## Requirements

- Linux host with Docker Engine 26+ and the Compose plugin.
- A DNS name (`FUDISLTE_DOMAIN`) pointing at the host, or a private CA (see below).
- **An SMTP relay.** People sign in with one-time codes sent to their work email, so the
  API refuses to start without `FUDISLTE_SMTP_HOST` and `FUDISLTE_SMTP_FROM`. Use your own
  mail server, the Microsoft 365 or Google Workspace SMTP relay, or a transactional email
  provider. Make sure SPF/DKIM allow the sender address so codes do not land in spam.
- Inbound TCP 80 and 443 (UDP 443 optional for HTTP/3). Nothing else is exposed;
  PostgreSQL sits on an internal network with no internet route.

## Install

**With Claude Code:** clone the repository on the server (or reach it over SSH), start
`claude` in the checkout and ask it to install FUDISLTE. The `install-fudislte` skill
(`.claude/skills/install-fudislte`) walks through every step below: it checks the server
(`scripts/install/preflight.sh`), writes `.env` with generated secrets
(`scripts/install/configure.sh`), sends a test email, starts the stack, verifies HTTPS
(`scripts/install/verify.sh`), and sets up backups. The scripts also work on their own.

**By hand:**

```bash
git clone <your FUDISLTE repository> fudislte && cd fudislte/infrastructure/docker
cp .env.example .env
# Edit .env: FUDISLTE_DOMAIN, a strong POSTGRES_PASSWORD (openssl rand -base64 32)
# and the FUDISLTE_SMTP_* settings
docker compose up -d --build
docker compose logs api | grep setup_token
```

Open `https://<FUDISLTE_DOMAIN>`, enter the setup token and your work email, then the code
that arrives by email, and create the first workspace. If the code never arrives, check
`docker compose logs api` for SMTP errors. The token works once; after setup it is no
longer accepted.

Then, under *Settings → Access*, add your company domain so colleagues can sign in with
their work email without individual invitations, and under *Settings → Security* create
access keys for people whose accounts you prepare and choose the session lifetime.

## Trying the stack locally (Windows with WSL, or any Linux)

The same images can run on a developer machine over plain HTTP. On Windows, Docker
Engine runs inside the WSL Ubuntu distribution, so Docker Desktop is not required:

```bash
wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/install-docker.sh   # once
wsl -d Ubuntu-24.04 -- bash scripts/wsl/docker-local.sh up          # build + start
```

Open `http://localhost:8088`. The setup token is printed by `up`; sign-in codes are
shown with `docker-local.sh codes` (the local override uses the log mail transport and
`FUDISLTE_ENV=development`). Stop with `docker-local.sh down`; data stays in the
`fudislte-local_*` volumes. Never expose this local configuration to a network.

## TLS on private networks

For servers without public DNS, edit `Caddyfile` and add `tls internal` inside the site
block. Caddy then issues certificates from its own root CA, stored in the `caddy-data`
volume (`/data/caddy/pki/authorities/local/root.crt`). Install that root certificate on
client machines (via group policy or MDM). FUDISLTE Desktop requires HTTPS and trusts the
operating system certificate store.

## Backups

[backup-restore.md](backup-restore.md) has scripts that do all of this, verify the result,
encrypt it and run restore drills; this section shows what they do underneath.

State lives in two places: PostgreSQL and the API's `api-data` volume, which holds
attached files ([ADR-0009](../decisions/0009-file-storage.md)). Back up both, daily and
before every upgrade — the database first, so a file uploaded in between is only an extra
file on disk, never a missing one:

```bash
docker compose exec -T postgres pg_dump -U fudislte -d fudislte --format=custom > fudislte-$(date +%F).dump
docker cp "$(docker compose ps -q api):/var/lib/fudislte/files" - > fudislte-files-$(date +%F).tar
```

`docker cp` works although the API image has no shell or `tar`. Messages and files
removed by the workspace's retention setting stay in older backups until those are
rotated; keep backups no longer than your retention policy allows.

Encrypt backups before they leave the host, for example with `age`:

```bash
age -r <recipient-public-key> -o fudislte-$(date +%F).dump.age fudislte-$(date +%F).dump
age -r <recipient-public-key> -o fudislte-files-$(date +%F).tar.age fudislte-files-$(date +%F).tar
```

## Restore

```bash
docker compose stop api web
docker compose exec -T postgres dropdb -U fudislte fudislte
docker compose exec -T postgres createdb -U fudislte fudislte
docker compose exec -T postgres pg_restore -U fudislte -d fudislte --no-owner < fudislte-YYYY-MM-DD.dump
docker cp -a - "$(docker compose ps -aq api):/var/lib/fudislte" < fudislte-files-YYYY-MM-DD.tar
docker compose start api web
```

Test restores regularly on a separate host; an untested backup is not a backup.
`scripts/ops/restore.sh` does these steps and checks every table and file afterwards, and
`scripts/ops/restore-drill.sh` rehearses a restore without touching the running
deployment — see [backup-restore.md](backup-restore.md), including what to do after a
restore.

## Upgrades

1. Back up (above).
2. `git pull` the new release and read its release notes.
3. `docker compose up -d --build`. The API applies database migrations at startup under a
   lock; set `FUDISLTE_MIGRATE_ON_START=false` and run `docker compose run --rm api migrate`
   if you prefer explicit migrations.

## Encryption at rest

PostgreSQL has no built-in transparent data encryption. Use full-disk or volume
encryption (LUKS, cloud provider disk encryption) for the Docker data directory — it
holds the database and the attachment volume — and encrypt backups as shown above.

## Configuration reference (API)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FUDISLTE_DATABASE_URL` | — (required) | PostgreSQL connection string. The API keeps up to 20 connections and stops queries after 30 s; change them with `pool_max_conns=…` and `options=-c%20statement_timeout=…` in the URL |
| `FUDISLTE_PUBLIC_URL` | — (required) | Address people open, used in emails (`https://…`) |
| `FUDISLTE_SMTP_HOST` / `FUDISLTE_SMTP_PORT` | — / `587` | SMTP relay for sign-in codes and invitations |
| `FUDISLTE_SMTP_TLS` | `starttls` | `starttls`, `tls` (port 465) or `none` (loopback relays only) |
| `FUDISLTE_SMTP_USERNAME` / `FUDISLTE_SMTP_PASSWORD` | empty | SMTP authentication |
| `FUDISLTE_SMTP_FROM` | — (required) | Sender, e.g. `FUDISLTE <fudislte@company.com>` |
| `FUDISLTE_ENV` | `production` | `development` allows `http://` public URLs and `FUDISLTE_MAIL_TRANSPORT=log` |
| `FUDISLTE_HTTP_ADDR` | `:8080` | Listen address |
| `FUDISLTE_COOKIE_SECURE` | `true` | Secure + `__Host-` session cookie; set `false` only for local HTTP development |
| `FUDISLTE_SETUP_TOKEN` | generated | First-run setup token (≥16 characters) |
| `FUDISLTE_TRUSTED_PROXIES` | none | CIDRs allowed to set `X-Forwarded-For` |
| `FUDISLTE_MIGRATE_ON_START` | `true` | Apply migrations at startup |
| `FUDISLTE_SESSION_IDLE_TTL` | `168h` | Unused sessions end after this. How long a sign-in lasts at most (48 hours by default) is set by instance administrators in *Settings → Security* and applies to every session at once |
| `FUDISLTE_LOG_LEVEL` / `FUDISLTE_LOG_FORMAT` | `info` / `json` | Logging |
| `FUDISLTE_REGISTRY_URL` | the project's registry, if any | Where opt-in registration reports go (`off` disables); see [registry.md](registry.md) |
| `FUDISLTE_DATA_DIR` | `/var/lib/fudislte` | Attachments (the `api-data` volume in Compose); must be writable by the API user |
| `FUDISLTE_MAX_UPLOAD_MB` | `25` | Largest attachment, 1–1024 MB |
| `FUDISLTE_LIVEKIT_URL` | empty (voice off) | What clients connect to, e.g. `wss://fudislte.example.com/livekit` |
| `FUDISLTE_LIVEKIT_API_URL` | derived from the URL | How the API reaches LiveKit (`http://livekit:7880` in Compose) |
| `FUDISLTE_LIVEKIT_API_KEY` / `FUDISLTE_LIVEKIT_API_SECRET` | — | Shared with LiveKit; the secret needs at least 32 characters |

## Voice and video (optional)

Voice rooms, video and screen sharing run through a LiveKit server beside FUDISLTE
([ADR-0011](../decisions/0011-media-livekit.md)). Without it everything else works and
rooms simply have no voice.

1. Generate a key and a secret and add them to `.env`:

   ```bash
   echo "FUDISLTE_LIVEKIT_API_KEY=API$(openssl rand -hex 6)" >> .env
   echo "FUDISLTE_LIVEKIT_API_SECRET=$(openssl rand -hex 24)" >> .env
   ```

2. In `.env` set `COMPOSE_PROFILES=media` and
   `FUDISLTE_LIVEKIT_URL=wss://<FUDISLTE_DOMAIN>/livekit`. Caddy forwards `/livekit/*` to
   LiveKit, so signalling uses the same certificate as the rest of FUDISLTE.
3. Open in the firewall: **UDP 7882** (media), **TCP 7881** (media fallback) and
   **UDP 3478** (built-in TURN for networks that block other UDP). LiveKit discovers
   its public IP with STUN; behind NAT or on private networks set
   `FUDISLTE_LIVEKIT_NODE_IP` to the address clients reach.
4. `docker compose up -d`. The API reaches LiveKit at `http://livekit:7880`, and LiveKit
   sends signed webhooks to the API on the internal network.

Plan roughly 50–100 kbit/s per person per direction for voice and 1–3 Mbit/s per video
or screen share. One LiveKit node serves one installation.

## AI assistant (optional)

Summaries, search across messages and documents, task suggestions and agents come from a
separate AI worker ([ADR-0012](../decisions/0012-ai-worker.md),
[ai-worker.md](../architecture/ai-worker.md)). Without it everything else works exactly
the same. The worker publishes no port, sits on internal networks without an internet
route and keeps its own vector database, so workspace content stays on this host.

1. Add `FUDISLTE_AI_SHARED_SECRET` and `FUDISLTE_AI_POSTGRES_PASSWORD` to `.env`
   (`openssl rand -hex 32` each).
2. Choose a model server: `--profile ollama` runs Ollama in the same stack, or point
   `FUDISLTE_AI_LLM_URL` at a vLLM or other OpenAI-compatible server on your network.
   Set `FUDISLTE_AI_LLM_KIND`, `FUDISLTE_AI_LLM_MODEL` and `FUDISLTE_AI_EMBED_MODEL` as the
   guide describes; a model server outside your network is refused unless you allow it.
3. Start with the overlay:
   `docker compose -f compose.yml -f compose.ai.yml [--profile ollama] up -d --build`.

The API side of the integration is still being built (roadmap Phases 8 and 9).
