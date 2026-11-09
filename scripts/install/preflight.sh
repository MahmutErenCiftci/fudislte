#!/usr/bin/env bash
# Checks whether this Linux host is ready for a FUDISLTE Docker Compose deployment.
# Read-only: it installs and changes nothing. Used by the install skill
# (.claude/skills/install-fudislte) and usable on its own.
#
#   bash scripts/install/preflight.sh [-d DOMAIN] [-s SMTP_HOST:PORT] [--media]
#
# Every line is "OK", "WARN" or "FAIL", a check name and details. Exit status 1 when any
# check fails, 0 otherwise.
set -uo pipefail

domain="" smtp="" media=0
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--domain) domain="$2"; shift 2 ;;
    -s|--smtp) smtp="$2"; shift 2 ;;
    --media) media=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

failed=0
ok() { printf 'OK    %-12s %s\n' "$1" "$2"; }
warn() { printf 'WARN  %-12s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-12s %s\n' "$1" "$2"; failed=1; }

# Operating system and privileges.
if [ "$(uname -s)" != "Linux" ]; then
  fail os "$(uname -s): FUDISLTE servers run Linux"
else
  os="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}")"
  ok os "${os:-Linux} ($(uname -m))"
fi
if [ "$(id -u)" -eq 0 ]; then
  ok privileges "running as root"
elif sudo -n true 2>/dev/null; then
  ok privileges "passwordless sudo"
else
  warn privileges "not root and no passwordless sudo: installing Docker and opening ports need root"
fi

# Size (docs/deployment/docker-compose.md: small = 2 vCPU, 4 GB RAM, 40 GB SSD).
cpus="$(nproc 2>/dev/null || echo 0)"
mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$cpus" -ge 2 ]; then ok cpu "$cpus vCPU"; else warn cpu "$cpus vCPU: 2 or more recommended"; fi
if [ "$mem_mb" -ge 3500 ]; then ok memory "$mem_mb MB"
elif [ "$mem_mb" -ge 1800 ]; then warn memory "$mem_mb MB: 4 GB recommended; fine for a few people"
else fail memory "$mem_mb MB: at least 2 GB needed"; fi
data_dir=/var/lib/docker
[ -d "$data_dir" ] || data_dir=/var/lib
free_gb="$(df -Pk "$data_dir" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')"
if [ "${free_gb:-0}" -ge 20 ]; then ok disk "$free_gb GB free on $data_dir"
elif [ "${free_gb:-0}" -ge 8 ]; then warn disk "$free_gb GB free on $data_dir: 40 GB recommended (messages, files, backups)"
else fail disk "${free_gb:-0} GB free on $data_dir: at least 8 GB needed"; fi

# Docker Engine 26+ with the Compose plugin.
if command -v docker >/dev/null 2>&1; then
  version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [ -z "$version" ]; then
    fail docker "installed but the daemon is not reachable (is it running? are you root or in the docker group?)"
  elif [ "${version%%.*}" -ge 26 ] 2>/dev/null; then
    ok docker "Docker Engine $version"
  else
    fail docker "Docker Engine $version: 26 or newer needed"
  fi
  if docker compose version >/dev/null 2>&1; then
    ok compose "$(docker compose version --short 2>/dev/null)"
  else
    fail compose "the Docker Compose plugin is missing"
  fi
  # infrastructure/docker/compose.yml puts Caddy and the API on 172.28.0.0/24, and the
  # API trusts X-Forwarded-For only from there. Another network on it blocks the start.
  if [ -n "$version" ]; then
    ip2int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
    edge_lo=$(ip2int 172.28.0.0) edge_hi=$(( $(ip2int 172.28.0.0) + 255 )) clash=""
    while read -r name subnets; do
      [ "$name" = "fudislte_edge" ] && continue
      for s in $subnets; do
        case "$s" in *:*|"") continue ;; esac
        lo=$(ip2int "${s%/*}") bits="${s#*/}"
        hi=$(( lo + (1 << (32 - bits)) - 1 ))
        if [ "$lo" -le "$edge_hi" ] && [ "$hi" -ge "$edge_lo" ]; then clash="$clash $name ($s)"; fi
      done
    done < <(docker network ls -q | xargs -r docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)
    if [ -n "$clash" ]; then
      fail network "172.28.0.0/24, which FUDISLTE uses, is taken by:$clash — remove that network if unused, or change the subnet in compose.yml and FUDISLTE_TRUSTED_PROXIES together"
    else
      ok network "172.28.0.0/24 free for FUDISLTE"
    fi
  fi
else
  fail docker "not installed (install: curl -fsSL https://get.docker.com | sh)"
fi

# Ports Caddy needs; LiveKit's when voice and video are wanted.
listening="$(ss -Htuln 2>/dev/null || true)"
port_free() { ! printf '%s\n' "$listening" | awk '{print $1, $5}' | grep -qE "^$1 .*[:.]$2$"; }
for p in 80 443; do
  if port_free tcp "$p"; then ok "port $p" "free"; else fail "port $p" "already in use: $(ss -Htlnp "sport = :$p" 2>/dev/null | awk '{print $NF}' | head -1)"; fi
done
if [ "$media" -eq 1 ]; then
  for spec in tcp:7881 udp:7882 udp:3478; do
    if port_free "${spec%%:*}" "${spec##*:}"; then ok "port $spec" "free"; else fail "port $spec" "already in use"; fi
  done
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for p in 80 443; do
    if ufw status | grep -qE "^$p(/tcp)?[[:space:]]+ALLOW"; then ok "ufw $p" "allowed"; else warn "ufw $p" "firewall active and port $p not allowed (ufw allow $p/tcp)"; fi
  done
fi

# The domain must point here for Caddy to obtain a certificate.
if [ -n "$domain" ]; then
  resolved="$(getent ahosts "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  if [ -z "$resolved" ]; then
    fail dns "$domain does not resolve: add an A record pointing at this server"
  else
    local_ips="$(ip -o addr show 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | tr '\n' ' ')"
    match=0
    for r in $resolved; do case " $local_ips " in *" $r "*) match=1 ;; esac; done
    if [ "$match" -eq 1 ]; then
      ok dns "$domain → $resolved(an address of this host)"
    else
      warn dns "$domain → $resolved; not an address of this host. Fine behind cloud NAT if that is the server's public IP, otherwise fix the A record"
    fi
  fi
fi

# Sign-in codes go out by email, so the relay must be reachable.
if [ -n "$smtp" ]; then
  host="${smtp%:*}" port="${smtp##*:}"
  if timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
    ok smtp "$host:$port reachable"
  else
    fail smtp "$host:$port not reachable (wrong host or port, or the provider blocks outgoing mail ports)"
  fi
fi

# Caddy needs Let's Encrypt for public certificates; the build needs registries.
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 10 -o /dev/null https://acme-v02.api.letsencrypt.org/directory 2>/dev/null; then
    ok internet "Let's Encrypt reachable"
  else
    warn internet "Let's Encrypt not reachable: public certificates will fail (fine on private networks with tls internal)"
  fi
else
  warn internet "curl missing; install it (apt-get install -y curl)"
fi

exit "$failed"
