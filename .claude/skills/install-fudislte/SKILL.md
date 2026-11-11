---
name: install-fudislte
description: Installs FUDISLTE on a Linux server from start to finish with Docker Compose — checks the server, writes the configuration, tests email, starts the stack with automatic HTTPS, verifies it, sets up backups and hands over the first steps. Use when someone asks to install, deploy or set up FUDISLTE on a server, VPS, VDS or cloud machine (AWS, Azure, Google Cloud, Hetzner, a company data centre), also in Turkish ("FUDISLTE'yi kur", "sunucuya kur").
---

# Install FUDISLTE

You are installing FUDISLTE for a company's IT team on their own Linux server. Work
through the steps in order and finish only when `verify.sh` passes and the user has what
they need to sign in. The reference for everything here is
`docs/deployment/docker-compose.md`; backups are in `docs/deployment/backup-restore.md`.

## Ground rules

- **Speak the user's language**; keep commands and file contents as they are.
- **Where commands run:** on the target server. If Claude Code runs on the server, run
  them directly (as root or with `sudo`). Otherwise run them over SSH with access the
  user already has (`ssh HOST 'cd /opt/fudislte && …'`). Never type or ask for an SSH or
  sudo password — if one is needed, ask the user to set up key access or to run that
  step themselves.
- **Agree on the plan once**, before the first change to the server (installing Docker,
  opening firewall ports, writing files, starting containers). Ask again only for
  anything not in that plan, and for anything destructive.
- **Secrets stay out of the chat.** Never ask for the SMTP password in the conversation:
  the user types it into the file (step 5). Do not print `.env`; read single non-secret
  values with `grep`. The setup token is the one secret you show — the user needs it once.
- **Never weaken security to get past an error:** no `FUDISLTE_ENV=development`, no
  `FUDISLTE_COOKIE_SECURE=false`, no `FUDISLTE_MAIL_TRANSPORT=log`, no published PostgreSQL
  port, no plain HTTP. Find and fix the cause instead.
- **The company decides about the product:** registering the server with the FUDISLTE
  project is a box in the setup screen that the user may tick or not. Never tick it, or
  turn registration on, for them.
- If a step fails, stop, read the logs, fix the cause, and run the check again.

## 1. Collect the answers (ask everything in one message)

1. **Where:** is Claude Code running on the server itself, or which SSH host should you use?
2. **Address:** the DNS name people will open, for example `chat.company.com`. Reachable
   from the internet, or only inside the company network (VPN, LAN)?
3. **Email** — required, people sign in with codes sent by email: SMTP host, port (587
   with STARTTLS or 465 with TLS), user name, and the sender address. Usual choices:
   Microsoft 365 (`smtp.office365.com`, 587, a mailbox allowed to use SMTP AUTH), Google
   Workspace (`smtp-relay.gmail.com`, 587), the company's own mail server, or a
   transactional email service.
4. **Voice and video rooms?** They need extra ports and about 4 vCPU per ~25 people talking
   at once.
5. **How many people,** roughly (for sizing).
6. **Backups:** a directory on another disk or mount, ideally encrypted. Can wait until
   step 9.

## 2. Get the code onto the server

If the working directory is a FUDISLTE checkout (it has `infrastructure/docker/compose.yml`
and `scripts/install/`), use it. Otherwise install into `/opt/fudislte`:
`git clone <repository URL> /opt/fudislte` — ask the user for the URL or for a release
archive to unpack there. Every path below is relative to the checkout.

## 3. Check the server

```bash
bash scripts/install/preflight.sh -d DOMAIN -s SMTP_HOST:PORT [--media]
```

Fix every `FAIL`, then run it again:

- **docker / compose missing:** with the user's agreement, install Docker Engine from
  Docker's package repository (https://docs.docker.com/engine/install/). If the user
  prefers Docker's convenience script, download it first and run it as a file, never piped
  into a root shell: `curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh`.
- **port 80 or 443 in use:** find what holds it (`ss -tlnp`); usually another web server.
  Ask the user before stopping or removing it — FUDISLTE's Caddy needs both ports.
- **dns:** the user adds an `A` record (and `AAAA` if the server has IPv6) at their DNS
  provider; rerun after a few minutes. A `WARN` saying the address is not on this host is
  normal behind cloud NAT (AWS, Azure, GCP) when it is the server's public IP — confirm
  with the user. Internal-only servers: see step 6b.
- **network:** another Docker network uses 172.28.0.0/24. If it belongs to something
  stopped and unused, remove it with the user's OK (`docker network rm NAME`). If it is in
  use, change the `edge` subnet in `infrastructure/docker/compose.yml` and
  `FUDISLTE_TRUSTED_PROXIES` in the same file to the same free range, and tell the user.
- **smtp not reachable:** check host and port with the user; many clouds block port 25,
  so use 587 or 465.
- **memory / disk:** tell the user what the limit means; continue only if they accept.

Firewalls: if `ufw` is active, open the ports:
`ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp`, plus `7881/tcp`,
`7882/udp` and `3478/udp` for voice and video. Remind the user that a cloud firewall
(AWS security group, Azure NSG, Hetzner firewall) must allow the same ports — you cannot
see it from the server.

## 4. Write the configuration

```bash
bash scripts/install/configure.sh -d DOMAIN --smtp-host HOST --smtp-port PORT \
  --smtp-tls starttls|tls --smtp-user USER --smtp-from 'FUDISLTE <sender@company.com>' [--media]
```

It writes `infrastructure/docker/.env` (mode 600) with a generated database password,
setup token and, with `--media`, LiveKit keys. If `.env` already exists, ask before using
`--force`: it changes the database password, which breaks a database that was already
created — only use it when the stack has never started.

## 5. The SMTP password (the user enters it)

Ask the user to open the file in their own terminal and type the password between the
single quotes of the `FUDISLTE_SMTP_PASSWORD=''` line, for example with
`sudo nano /opt/fudislte/infrastructure/docker/.env` in a separate SSH session. Single
quotes keep characters such as `$` intact; a password containing `'` itself does not
work there — suggest an app password without it. Then check that it is set without
showing it:

```bash
grep -c "^FUDISLTE_SMTP_PASSWORD='." infrastructure/docker/.env   # 1 means set
```

Skip this step only if the relay needs no authentication.

## 6. Build and test email before going live

```bash
cd infrastructure/docker
docker compose build                                          # takes a few minutes
docker compose run --rm --no-deps api mailtest THEIR_EMAIL    # sends one test email
```

Ask the user to confirm the email arrived (also in spam). If not, the error names the
cause: authentication, TLS mode, or a sender the account may not use. Codes that land in
spam need SPF/DKIM for the sender's domain — tell the user, it is set at their DNS
provider.

### 6b. Internal-only servers

Without public DNS, Let's Encrypt cannot issue a certificate. Add `tls internal` inside
the site block of `infrastructure/docker/Caddyfile` (see "TLS on private networks" in the
deployment guide). After step 7, give the user Caddy's root certificate to install on
company devices (group policy or MDM):
`docker compose cp web:/data/caddy/pki/authorities/local/root.crt ./fudislte-root.crt`.
Use `verify.sh --insecure` on the server itself.

## 7. Start and verify

```bash
docker compose up -d
cd ../.. && bash scripts/install/verify.sh -d DOMAIN [--insecure]
```

On `FAIL`, read `docker compose logs --tail=100 web api` in `infrastructure/docker`.
Typical causes: no certificate → DNS or a cloud firewall blocking port 80/443; `api`
restarting → a configuration value (the log names it); `web` waiting → `api` not healthy.

## 8. Hand over

Give the user:

- the address, `https://DOMAIN`;
- the setup token, once: `grep '^FUDISLTE_SETUP_TOKEN=' infrastructure/docker/.env | cut -d'"' -f2`
  (it works only for the first setup).

Their first steps in the browser:

1. Open the address, enter the setup token and their work email, then the emailed code,
   and create the workspace. The box about letting the FUDISLTE project know about the
   installation is optional and their call.
2. **Settings → Security → Access keys:** prepare accounts for colleagues (email, name,
   role, language). Each person chooses "I have an access key" on the sign-in page,
   enters the key and is in at once; later sign-ins use email codes.
3. **Settings → Security → Session lifetime:** 48 hours by default, for everyone.
4. **Settings → Access:** add the company email domain and verify it with a DNS TXT record,
   so colleagues can join with their work email and administrators can create access keys.
5. The desktop app (Windows, macOS, Linux) connects to the same address.

## 9. Backups

Strongly recommend them; set them up with the user's agreement. Backups are always
encrypted with `age`; the private key must never be created or stored on this server.

1. Install `age` on the server (`apt install age`).
2. Ask the user to create the key pair on their own computer (`age-keygen -o
   fudislte-backup.key`), keep the key file offline in two places, and paste only the
   **public** key (`age1…`). Never ask for the private key and never run `age-keygen`
   here. Without that key the backups cannot be restored.
3. Take the first backup:

```bash
mkdir -p /var/backups/fudislte                       # on another disk if possible
bash scripts/ops/backup.sh -p fudislte -o /var/backups/fudislte --with-caddy -r age1…
```

Recommend storage the server can add to but not change (another host that pulls the
backups, or object storage with object lock). Then add
the daily cron entry from `docs/deployment/backup-restore.md` ("Taking a backup"),
adapted to this checkout's path, and show the user the result of the first run.

## 10. Close

Finish with a short summary for the user: the address; where FUDISLTE lives (the
checkout, `infrastructure/docker/.env` with mode 600 — keep a copy in the company's
password manager); voice and video on or off; the backup schedule and location; and how
to update (back up, `git pull`, `docker compose up -d --build` in `infrastructure/docker`,
read the release notes first). Mention anything left open, such as SPF/DKIM or a cloud
firewall rule only the user can change.
