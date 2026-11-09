#!/usr/bin/env bash
# Writes infrastructure/docker/.env for a FUDISLTE deployment from .env.example, with
# freshly generated database password, setup token and (with --media) LiveKit keys.
# Used by the install skill (.claude/skills/install-fudislte) and usable on its own.
#
#   bash scripts/install/configure.sh -d DOMAIN --smtp-host HOST --smtp-from 'FUDISLTE <fudislte@company.com>' \
#     [--smtp-port 587] [--smtp-tls starttls|tls|none] [--smtp-user USER] \
#     [--media [--node-ip IP]] [--env-file PATH] [--force]
#
# The SMTP password is never taken as an argument (it would land in shell history and
# process lists): set FUDISLTE_SMTP_PASSWORD in the environment, or add it to the file
# afterwards. An existing env file is kept unless --force is given. The file is mode 600.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="$root/infrastructure/docker/.env"
domain="" smtp_host="" smtp_port=587 smtp_tls=starttls smtp_user="" smtp_from="" media=0 node_ip="" force=0

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--domain) domain="$2"; shift 2 ;;
    --smtp-host) smtp_host="$2"; shift 2 ;;
    --smtp-port) smtp_port="$2"; shift 2 ;;
    --smtp-tls) smtp_tls="$2"; shift 2 ;;
    --smtp-user) smtp_user="$2"; shift 2 ;;
    --smtp-from) smtp_from="$2"; shift 2 ;;
    --media) media=1; shift ;;
    --node-ip) node_ip="$2"; shift 2 ;;
    --env-file) env_file="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "configure: $*" >&2; exit 1; }
[[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "--domain must be a DNS name such as chat.company.com (lower case)"
[ -n "$smtp_host" ] || die "--smtp-host is required: people sign in with codes sent by email"
[[ "$smtp_port" =~ ^[0-9]{1,5}$ ]] || die "--smtp-port must be a port number"
case "$smtp_tls" in starttls|tls|none) ;; *) die "--smtp-tls must be starttls, tls or none" ;; esac
[[ "$smtp_from" == *@* ]] || die "--smtp-from must be an address such as 'FUDISLTE <fudislte@company.com>'"
for v in "$domain" "$smtp_host" "$smtp_user" "$smtp_from" "$node_ip"; do
  case "$v" in *'"'*|*$'\n'*|*'$'*|*'`'*|*'\'*) die "values may not contain quotes, backslashes, \$, backticks or line breaks" ;; esac
done
# The password is written single-quoted, which Compose takes literally ($ included).
case "${FUDISLTE_SMTP_PASSWORD:-}" in *"'"*|*$'\n'*) die "the SMTP password may not contain ' or line breaks; use an app password without them" ;; esac
if [ -e "$env_file" ] && [ "$force" -ne 1 ]; then
  die "$env_file already exists; keep it, or run again with --force to replace it (its passwords then change too)"
fi

random() { head -c "$1" /dev/urandom | base64 | tr -d '/+=\n' | head -c "$2"; }

# Start from the example so every documented setting stays in the file.
umask 077
tmp="$(mktemp "$(dirname "$env_file")/.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cp "$root/infrastructure/docker/.env.example" "$tmp"

# set KEY VALUE [QUOTE] replaces the KEY= line, or appends it. Compose expands $VAR
# inside double quotes and takes single-quoted values literally.
set_var() {
  KEY="$1" VALUE="$2" Q="${3:-\"}" awk '
    BEGIN { key = ENVIRON["KEY"]; q = ENVIRON["Q"]; line = key "=" q ENVIRON["VALUE"] q }
    index($0, key "=") == 1 { print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp"
}

set_var FUDISLTE_DOMAIN "$domain"
set_var POSTGRES_PASSWORD "$(random 48 40)"
set_var FUDISLTE_SETUP_TOKEN "$(random 32 32)"
set_var FUDISLTE_SMTP_HOST "$smtp_host"
set_var FUDISLTE_SMTP_PORT "$smtp_port"
set_var FUDISLTE_SMTP_TLS "$smtp_tls"
set_var FUDISLTE_SMTP_USERNAME "$smtp_user"
set_var FUDISLTE_SMTP_PASSWORD "${FUDISLTE_SMTP_PASSWORD:-}" "'"
set_var FUDISLTE_SMTP_FROM "$smtp_from"
if [ "$media" -eq 1 ]; then
  set_var COMPOSE_PROFILES media
  set_var FUDISLTE_LIVEKIT_URL "wss://$domain/livekit"
  set_var FUDISLTE_LIVEKIT_API_KEY "API$(random 24 12)"
  set_var FUDISLTE_LIVEKIT_API_SECRET "$(random 64 48)"
  set_var FUDISLTE_LIVEKIT_NODE_IP "$node_ip"
fi

chmod 600 "$tmp"
mv "$tmp" "$env_file"
trap - EXIT

echo "configure: wrote $env_file (mode 600)"
echo "configure: domain $domain, mail via $smtp_host:$smtp_port ($smtp_tls), voice and video $([ "$media" -eq 1 ] && echo on || echo off)"
if [ -n "$smtp_user" ] && [ -z "${FUDISLTE_SMTP_PASSWORD:-}" ]; then
  echo "configure: SMTP password not set: put it on the FUDISLTE_SMTP_PASSWORD= line of $env_file"
fi
