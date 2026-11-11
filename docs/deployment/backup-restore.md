# Backup, restore and restore drills

Operator guide for FUDISLTE deployments that run with Docker Compose
([docker-compose.md](docker-compose.md)). The scripts live in `scripts/ops/` and need bash,
Docker with the Compose plugin, GNU tar and `sha256sum` on the Docker host; `age` only
for encrypted backups.

| Script | Purpose |
| --- | --- |
| `scripts/ops/backup.sh` | Backs up one deployment: database, attachments, optionally Caddy's data, plus a manifest |
| `scripts/ops/restore.sh` | Restores such a backup into a deployment (same host or a new one) and verifies it |
| `scripts/ops/restore-drill.sh` | Backs up a running deployment, restores it into a new isolated project, compares, removes the copy |
| `scripts/ops/drill-fixture.sh` | Creates a throwaway deployment filled with realistic data, as a drill source |
| `scripts/ops/compose.drill.yml` | Compose overlay for drill copies: same images, own networks and volumes, no published ports |

Every script prints its options with `--help`.

## What FUDISLTE's state is

| State | Where | In the backup |
| --- | --- | --- |
| Database `fudislte` (accounts, workspaces, messages, sessions, audit log, …) | `postgres-data` volume | `fudislte.dump`, `pg_dump --format=custom` |
| Attachments ([ADR-0009](../decisions/0009-file-storage.md)) | `api-data` volume, `/var/lib/fudislte/files/<workspace>/<file>` | `files.tar` (`docker cp`), `files.sha256` |
| Caddy's certificates and keys | `caddy-data` volume, `/data/caddy` | `caddy.tar` with `--with-caddy` |
| Secrets and settings | `infrastructure/docker/.env` | **No** — keep a copy in your password manager or secrets vault |

`caddy.tar` matters with `tls internal` (private networks): it holds the private root CA that
client machines trust, and losing it means distributing a new root certificate. With public
certificates Caddy simply requests new ones on the restored host. It contains private keys:
treat it like the `.env` file.

The `.env` file is deliberately not in the backup set: it holds the database password, SMTP
and LiveKit credentials, which should never sit next to the data they protect. A restore
works with any `POSTGRES_PASSWORD` (the dump carries no role passwords), so a new host can
use a new one.

## Taking a backup

```bash
scripts/ops/backup.sh -p fudislte -o /var/backups/fudislte --with-caddy \
  -r age1qy…your-public-key…                                    # production stack
scripts/ops/backup.sh -p fudislte -o /mnt/encrypted/backups --unencrypted   # plaintext: only on an encrypted disk
```

`-p` is the Compose project name (`docker compose ls`), `-d` the directory of the compose
files (default `infrastructure/docker`), `-f`/`-e` the compose files and env file when they
are not `compose.yml` and `.env`. The local WSL stack, for example:
`-p fudislte-local -f compose.yml -f compose.local.yml -e .env.local`.

The script never stops or changes the deployment. It:

1. dumps the database with `pg_dump` inside the postgres container;
2. reads the whole dump back with `pg_restore` (proves it is complete and readable) and
   counts the rows of every table **in the dump's own snapshot**;
3. copies `/var/lib/fudislte/files` out of the api container — after the dump, so a file
   uploaded in between is at worst an extra file, never a missing one — and records the
   SHA-256 of every file;
4. records images, API and PostgreSQL versions and the schema (migration) version;
5. optionally encrypts with `age`, then writes `SHA256SUMS`.

Result: `/var/backups/fudislte/fudislte-<project>-<UTC time>/`

```
MANIFEST      format, time, host, images, versions, schema version, rows.<table>, sizes and
              SHA-256 of the plaintext files (no message content)
SHA256SUMS    for: cd <backup> && sha256sum -c SHA256SUMS
fudislte.dump   (.age when encrypted)
files.tar     (.age)
files.sha256  (.age)
caddy.tar     (.age, with --with-caddy)
```

On the laptop stack a backup takes 2–4 s; the dump grows with the message count and
`files.tar` with the attachments, so measure it on your data (see the drill output below).

### Schedule and retention

- **Daily**, at a quiet hour, and **before every upgrade** (the API migrates the database at
  start; a pre-upgrade backup is the way back).
- Keep, for example, 7 daily, 4 weekly and 3 monthly backups — but never longer than the
  workspace's message retention allows: messages and files deleted by retention stay in
  older backups until those are rotated away.
- The output directory needs room for at least two backups; the backup is removed again if
  any step fails.

A root crontab entry on the Docker host (adapt paths, recipient and project name):

```cron
# m h dom mon dow  command
15 2 * * *  bash /opt/fudislte/scripts/ops/backup.sh -p fudislte -o /var/backups/fudislte -r age1qy… --with-caddy >>/var/log/fudislte-backup.log 2>&1 && find /var/backups/fudislte -maxdepth 1 -name 'fudislte-fudislte-*' -mtime +14 -exec rm -rf {} +
```

Alert on failure (non-zero exit status, or no new directory for 26 hours) with whatever
monitoring you have: a backup job that fails silently is the most common way to end up
with no backups.

### Encryption

Backups hold every message and file in plaintext. Encrypt them before they leave the host:

```bash
sudo apt install age                     # Ubuntu 22.04+ / Debian 12+
age-keygen -o fudislte-backup.key          # on an offline machine; prints the public key
```

Give `backup.sh` only the **public** key (`-r age1…`, or `-R recipients.txt` for several
administrators). Keep the private key offline (password manager, safe, a second
administrator) — without it the backups cannot be restored, and it must not live on the
server that holds the backups. Without `-r` or `-R` the script refuses to run unless you
pass `--unencrypted`, and with recipients it refuses to run when `age` is not installed
rather than writing plaintext.

Checksums and the manifest catch damaged backups, not forged ones: anyone who can write to
the backup storage and knows the public key can produce a backup that verifies. Keep
backups where the FUDISLTE server can add new ones but not change or delete old ones
(append-only or object-lock storage, or a backup host that pulls from the server), and
restore only backups you took yourself. The plaintext exists briefly in the output
directory while the backup is made; put that directory on an encrypted disk, as
[docker-compose.md](docker-compose.md#encryption-at-rest) recommends for the Docker data.

`MANIFEST` and `SHA256SUMS` stay readable, so integrity and contents can be checked without
the key; they contain host name, image IDs, versions, row counts and file sizes, but no
message text, names or email addresses.

### Off-site copy

Follow the 3-2-1 rule: three copies, two media, one off-site. Copy each finished backup
directory to storage outside the server's failure domain — another site, or object storage
with versioning or object lock against ransomware — with `rsync`, `rclone` or your backup
system, and check it **after** the copy:

```bash
rclone copy /var/backups/fudislte/fudislte-fudislte-20261030T021500Z remote:fudislte-backups/fudislte-fudislte-20261030T021500Z
cd <copied directory> && sha256sum -c SHA256SUMS
```

## Restoring

`restore.sh` replaces the database and the attachments of a deployment with a backup. It
asks you to type the project name (or takes `--yes`), then:

1. checks `SHA256SUMS`, decrypts with `-k <age identity>` if needed, and checks every file
   against the manifest — a damaged or tampered backup is refused before anything changes;
2. starts postgres, stops api and web (and creates the containers on a new host);
3. drops and recreates database `fudislte`, restores the dump **in one transaction**;
4. compares the row count of every table with the manifest;
5. replaces `/var/lib/fudislte/files` in the api volume with `docker cp -a` (keeps the owner
   the API runs as) and compares every file's SHA-256 with `files.sha256`;
6. restores Caddy's data when the backup has it; with `--revoke-sessions`, revokes every
   restored session;
7. starts api and web and waits until the api healthcheck passes.

### Same host (data loss, bad upgrade, corruption)

```bash
scripts/ops/restore.sh -p fudislte -i /var/backups/fudislte/fudislte-fudislte-20261030T021500Z
```

### New host (the server is gone)

1. Install Docker and check out the **same FUDISLTE version** the backup was made with
   (`api_version` and `image.api` in `MANIFEST`), or a newer one — never an older one.
2. Create `infrastructure/docker/.env` from your vault copy (a new `POSTGRES_PASSWORD` is
   fine) and build the images: `docker compose build`.
3. Copy the backup directory to the host and check it: `sha256sum -c SHA256SUMS`.
4. Restore:
   `scripts/ops/restore.sh -p fudislte -i <backup> [-k fudislte-backup.key]`
   The row-count and file checks of steps 4 and 5 above are the verification of the
   restore; keep the output.
5. Point DNS at the new host. With `tls internal`, restore with the `caddy.tar` backup or
   distribute the new root certificate.
6. Sign in and open a channel with attachments.

### After a restore

- **Everything after the backup is gone**: messages, files, new members and invitations
  since the backup time (`created_at` in `MANIFEST`). Tell people.
- **Security state goes back in time, too.** Sessions signed out, accounts disabled, members
  removed and room passwords changed *after* the backup are active again. When restoring
  because of a security incident, add `--revoke-sessions`: every restored session is revoked
  before the API starts, so everyone signs in again with an email code (tested: a token
  that still worked on the source got HTTP 401 from the restored copy). Then redo the
  security changes made since the backup.
- Retention runs a minute after the API starts: messages that are past the workspace's
  retention by now are deleted again, and unsent uploads older than a day are removed.
- A newer API version migrates the restored database at start (one-way); keep the backup.

## Restore drills

An untested backup is not a backup. `restore-drill.sh` proves the procedure end to end
without touching the running deployment:

```bash
scripts/ops/restore-drill.sh                     # default source: fudislte-local (scripts/wsl/docker-local.sh)
scripts/ops/restore-drill.sh --source-project fudislte --source-file compose.yml --source-env-file .env
```

It backs up the source with `backup.sh --with-caddy`, restores the backup with
`restore.sh` into a **new** Compose project `fudislte-drill` built from `compose.yml` and
`scripts/ops/compose.drill.yml` — the source's exact image IDs, its own networks and
volumes, no published host ports, plain HTTP and log-only mail inside — verifies the copy,
and removes it with `docker compose -p fudislte-drill down -v`, also when a step fails. The
source is only read: `pg_dump`, `docker cp` out of its containers, `SELECT` queries,
`fudislte-api version`, and a `stat` of its data volume mounted read-only. The backup goes
to a private `/tmp/fudislte-drill.*` directory, deleted afterwards (`--keep` keeps both for
inspection; `--age` adds encryption with a throwaway key).

| Check | Passes when |
| --- | --- |
| `api` | the restored api container is healthy and `/readyz` reports the database ready |
| `web` | Caddy in the drill network proxies `/api/v1/meta` to the restored API (`setupRequired` as in the source) |
| `schema` | the migration version equals the source's |
| `rows` | row counts of users, organizations, memberships, roles, channels, channel_members, messages, attachments, notifications, audit_events, room_access, organization_domains and sessions equal the source's, counted right after the backup (the dump's own counts are shown too) |
| `files` | the sorted SHA-256 list of all attachment files equals the source's |
| `db-disk` | every `attachments` row has its file, with the SHA-256 the database recorded at upload |
| `owner` | the api volume and `files/` belong to the same user and mode as in the source |
| `serve` | the restored API returns every attachment byte for byte to its uploader (temporary sessions created in the drill database only) |

Run it monthly, after every upgrade and after any change to the backup scripts, and keep
the report (`--report FILE`).

### Drill results, 2026-10-30

Host: Windows 11 laptop, Docker Engine 29.1.3 and Compose 2.40.3 inside WSL2 (Ubuntu 24.04),
images `fudislte/api:0.1.0` (`sha256:1d204000b194…`, schema version 8), `fudislte/web:0.1.0`,
`postgres:17-alpine` (17.11).

**Drill A — the running local stack `fudislte-local`.** It held no data at the time (no
users, no attachments), so this run proves the mechanics against the real deployment but
not data fidelity:

```
$ bash scripts/ops/restore-drill.sh
FUDISLTE restore drill: fudislte-local -> fudislte-drill (started 2026-10-30T21:00:14Z, host Pekka)
backup:  fudislte-fudislte-local-20261030T210016Z in 4s; encryption none; 72K on disk
         api 0.1.0 (image sha256:1d204000b194…), PostgreSQL 17.11, schema version 8, 0 attachment files (0 bytes)
restore: 33s into the new project fudislte-drill (compose.yml + scripts/ops/compose.drill.yml, no published ports); drill total 41s
api      PASS  container healthy; GET /readyz -> {"status":"ready"}
web      PASS  Caddy -> API: GET /api/v1/meta -> {"product":"fudislte","setupRequired":true,"version":"0.1.0"}
schema   PASS  migration version 8 (source 8)
rows     PASS  13 tables equal (0 non-empty)
           users                  source        0  backup        0  drill        0  ok
           organizations          source        0  backup        0  drill        0  ok
           memberships            source        0  backup        0  drill        0  ok
           roles                  source        0  backup        0  drill        0  ok
           channels               source        0  backup        0  drill        0  ok
           channel_members        source        0  backup        0  drill        0  ok
           messages               source        0  backup        0  drill        0  ok
           attachments            source        0  backup        0  drill        0  ok
           notifications          source        0  backup        0  drill        0  ok
           audit_events           source        0  backup        0  drill        0  ok
           room_access            source   absent  backup   absent  drill   absent  ok
           organization_domains   source        0  backup        0  drill        0  ok
           sessions               source        0  backup        0  drill        0  ok
files    PASS  0 files, SHA-256 list identical to the source (e3b0c44298fc1c14…)
db-disk  PASS  0 attachment rows, each with its file and matching SHA-256; 0 files without a row
owner    PASS  /var/lib/fudislte 65532:65532 755; /var/lib/fudislte/files 65532:65532 700
serve    SKIP  no attachment to download
RESULT: PASSED
21:00:55Z  removing the drill: docker compose -p fudislte-drill down -v
```

**Drill B — a populated source.** `drill-fixture.sh up` created the isolated project
`fudislte-drillsrc` from the same images, completed first-run setup through the API (setup
token and emailed code read from the API log), added 8 members with sessions and filled the
workspace through the API (`tools/loadtest populate`): 2 extra channels (one private), 128
messages with Turkish text, mentions and multi-line bodies, 25 thread replies, 38 reactions,
an edit, a pin, a deletion, 6 attachments of 1 byte to 3 MiB with Turkish file names plus
one upload never sent, and a direct conversation.

```
$ bash scripts/ops/drill-fixture.sh up && bash scripts/ops/drill-fixture.sh drill && bash scripts/ops/drill-fixture.sh down
FUDISLTE restore drill: fudislte-drillsrc -> fudislte-drill (started 2026-10-30T21:01:30Z, host Pekka)
backup:  fudislte-fudislte-drillsrc-20261030T210131Z in 3s; encryption none; 4.5M on disk
         api 0.1.0 (image sha256:1d204000b194…), PostgreSQL 17.11, schema version 8, 7 attachment files (4521186 bytes)
restore: 32s into the new project fudislte-drill (compose.yml + scripts/ops/compose.drill.yml, no published ports); drill total 42s
api      PASS  container healthy; GET /readyz -> {"status":"ready"}
web      PASS  Caddy -> API: GET /api/v1/meta -> {"product":"fudislte","setupRequired":false,"version":"0.1.0"}
schema   PASS  migration version 8 (source 8)
rows     PASS  13 tables equal (11 non-empty)
           users                  source        9  backup        9  drill        9  ok
           organizations          source        1  backup        1  drill        1  ok
           memberships            source        9  backup        9  drill        9  ok
           roles                  source        9  backup        9  drill        9  ok
           channels               source        4  backup        4  drill        4  ok
           channel_members        source       22  backup       22  drill       22  ok
           messages               source      159  backup      159  drill      159  ok
           attachments            source        7  backup        7  drill        7  ok
           notifications          source       45  backup       45  drill       45  ok
           audit_events           source        3  backup        3  drill        3  ok
           room_access            source   absent  backup   absent  drill   absent  ok
           organization_domains   source        0  backup        0  drill        0  ok
           sessions               source        9  backup        9  drill        9  ok
files    PASS  7 files, SHA-256 list identical to the source (b3ba2c81cbf197db…)
db-disk  PASS  7 attachment rows, each with its file and matching SHA-256; 0 files without a row
owner    PASS  /var/lib/fudislte 65532:65532 755; /var/lib/fudislte/files 65532:65532 700
serve    PASS  7 attachments downloaded through the restored API, all byte-identical (0 skipped)
RESULT: PASSED
21:02:12Z  removing the drill: docker compose -p fudislte-drill down -v
```

`restore.sh` itself also compared all 17 tables of the dump (including `email_codes`,
`invitations`, `message_mentions`, `message_reactions` and `goose_db_version`) and every
attachment checksum before starting the API. Afterwards no container, volume or network of
`fudislte-drill` or `fudislte-drillsrc` was left, and `fudislte-local` was still running untouched.

Drill B was repeated independently at 21:14Z with a freshly created fixture: PASSED with
the same results (13 tables equal, 159 messages, 7 attachments byte-identical through the
restored API; backup 2 s, restore 32 s, drill 42 s), and nothing was left behind.

Negative tests on the same day: a backup with one changed byte in `files.tar` was refused
by `SHA256SUMS`; the same damage with a recomputed `SHA256SUMS` was refused by the manifest
check; `restore.sh` without `--yes` and without a terminal refused; `backup.sh -r …` without
`age` installed refused instead of writing plaintext. In none of these cases was anything
created or changed.

### What a drill proves, and what it does not

It proves that, on this host, with these images:

- the dump is complete and restorable in one transaction, and every table comes back with
  the same number of rows;
- every attachment comes back bit-identical, with the owner and permissions the API needs —
  the restored API serves them;
- a stack built from scratch (new volumes, new containers, new networks) starts from the
  backup alone, passes its healthcheck and serves the restored data through Caddy;
- the backup is self-describing: `restore.sh` checks it against its manifest wherever it
  runs.

It does **not** prove:

- **A restore on a clean host.** The drill runs on the same machine, the same Docker engine
  and with images that already exist. The roadmap's exit check — documented restore
  verified on a clean host — still needs the "New host" procedure above run once on a
  separate machine or fresh VM, with images rebuilt from the repository and the backup
  copied there; `restore.sh`'s row-count and checksum output is the evidence to keep.
- **Data fidelity on `fudislte-local`**, which was empty (drill A); drill B covers it with a
  fixture instead of production-like data.
- **Every table with content.** Drills A and B ran images at schema version 8. On
  2026-11-03 drill A was repeated with images rebuilt at schema version 13: PASSED,
  19 tables equal including meetings, projects, tasks, boards and board elements (a
  whiteboard with a text element came back intact), restore 33 s. Those deployments held
  no attachments and no projects or tasks, so their content is covered only by drill B's
  fixture (messages and files) and the board row.
- **Real encryption.** `age` is not installed on the test host; the encrypted path ran end
  to end only with a stand-in program that imitates age's command line without
  cryptography. Run `restore-drill.sh --age` once with real `age` installed.
- **Off-site transfer, the `.env` secrets from your vault, TLS certificate issuance for a
  real domain, SMTP and LiveKit** — none of them are part of a drill.
- **Recovery time for real data sizes.** 4.5 MB took 3 s to back up and about 32 s to
  restore, most of it waiting for health checks; time a drill with your own data.
- **Point-in-time recovery.** Backups are daily snapshots; work done since the last backup
  is lost. Continuous WAL archiving (e.g. pgBackRest) is the next step if that is not
  acceptable.
