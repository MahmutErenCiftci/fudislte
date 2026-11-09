# Registration and the project registry

FUDISLTE servers can tell the project that they exist — **only when an instance
administrator agrees.** Nothing is sent otherwise, and the option is not even shown
unless the server knows a registry address.

## What a server sends

Once a day, while registration is on, a server sends exactly this to the registry:

| Field | Value |
| --- | --- |
| `organizationName` | What the administrator entered (the first workspace's name by default) |
| `contactEmail` | What the administrator entered (their own email by default) |
| `userCount` | Number of accounts that are not disabled |
| `version` | The FUDISLTE version |
| `instanceId`, `secret` | A random server ID, and a random secret that proves later reports and the withdrawal come from the same server |

No messages, files, member lists, user names or emails, IP addresses or anything else.
The registry rejects reports with any other field.

- **Consent:** first-run setup offers an unchecked box; later, instance administrators
  turn it on or off in *Settings → Security*. Both are recorded in the audit log
  (`instance.registration_enabled`, `instance.registration_disabled`).
- **Withdrawal:** turning registration off deletes the server's record from the registry.
- **Address:** `FUDISLTE_REGISTRY_URL` (`https://…`, or `off`). Its default is
  `DefaultRegistryURL` in `services/api/internal/config/config.go`, empty until the project
  runs a registry; set it there or at build time with
  `-ldflags "-X fudislte/api/internal/config.DefaultRegistryURL=https://registry.example.org"`.

## Running the registry

`services/registry` is a small Go service (standard library only) that receives the
reports and lists them on a password-protected page, with a CSV export.
`infrastructure/registry` runs it behind Caddy, which obtains the HTTPS certificate.

You need a small Linux server (1 CPU and 1 GB of memory are plenty) with Docker Engine
and the Compose plugin, ports 80 and 443 open, and a DNS `A` record such as
`registry.example.org` pointing at it.

```bash
# On your computer, from the repository root: copy the files the kit needs.
tar czf fudislte-registry.tgz LICENSE NOTICE services/registry infrastructure/registry
scp fudislte-registry.tgz root@SERVER:

# On the server:
curl -fsSL https://get.docker.com | sh          # Docker Engine, if it is not installed
mkdir -p fudislte && tar xzf fudislte-registry.tgz -C fudislte
cd fudislte/infrastructure/registry
cp .env.example .env && nano .env               # REGISTRY_DOMAIN and the password
docker compose up -d --build
```

(Once the repository is public, `git clone` replaces the copying.) Then open
`https://registry.example.org/` and sign in with any user name and the password.
Instances that have not reported for three days are shown greyed out. To update, copy
the new files and run `docker compose up -d --build` again; the registrations live in
the `registry-data` volume.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUDISLTE_REGISTRY_ADMIN_PASSWORD` | — (required) | Password for the list page, at least 12 characters |
| `FUDISLTE_REGISTRY_ADDR` | `:8080` | Listen address |
| `FUDISLTE_REGISTRY_DATA_DIR` | `/var/lib/fudislte-registry` | Where `instances.json` is kept; back it up |
| `FUDISLTE_REGISTRY_TRUST_PROXY` | `false` | `true` behind a reverse proxy that appends `X-Forwarded-For` (used for rate limits) |
| `FUDISLTE_REGISTRY_MAX_INSTANCES` | `100000` | Most registrations kept |

The registry stores only the fields above plus when each server registered and last
reported; the secret is kept as a SHA-256 hash. Contact emails are personal data: keep
the page private and delete records on request (the administrator can also withdraw by
turning registration off).
