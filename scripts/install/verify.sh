#!/usr/bin/env bash
# Checks a started FUDISLTE deployment from the outside: containers healthy, HTTPS with a
# valid certificate, HTTP redirected, the API answering. Read-only.
# Used by the install skill (.claude/skills/install-fudislte) and usable on its own.
#
#   bash scripts/install/verify.sh -d DOMAIN [--insecure] [--wait SECONDS]
#
# --insecure skips certificate validation (private networks with "tls internal", whose
# root certificate this host may not trust). Exit status 1 when a check fails.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
domain="" insecure=0 wait=180
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--domain) domain="$2"; shift 2 ;;
    --insecure) insecure=1; shift ;;
    --wait) wait="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$domain" ] || { echo "verify: -d DOMAIN is required" >&2; exit 2; }

failed=0
ok() { printf 'OK    %-12s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-12s %s\n' "$1" "$2"; failed=1; }
cd "$root/infrastructure/docker" || exit 1

# Containers: wait until every service with a health check is healthy.
deadline=$((SECONDS + wait))
while :; do
  states="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)"
  pending="$(printf '%s\n' "$states" | awk 'NF && ($2 != "running" || ($3 != "" && $3 != "healthy"))')"
  [ -z "$pending" ] && [ -n "$states" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then break; fi
  sleep 3
done
if [ -z "$states" ]; then
  fail containers "none running: start them with docker compose up -d"
elif [ -n "$pending" ]; then
  fail containers "not ready after ${wait}s: $(printf '%s' "$pending" | tr '\n' ';') — see docker compose logs"
else
  ok containers "$(printf '%s\n' "$states" | awk '{print $1}' | tr '\n' ' ')running and healthy"
fi

curl_opts=(-sS -m 15)
[ "$insecure" -eq 1 ] && curl_opts+=(-k)

# HTTPS with a certificate the world trusts (unless --insecure).
meta="$(curl "${curl_opts[@]}" "https://$domain/api/v1/meta" 2>&1)"
if printf '%s' "$meta" | grep -q '"product":"fudislte"'; then
  ok https "https://$domain answers"
  if printf '%s' "$meta" | grep -q '"setupRequired":true'; then
    ok setup "waiting for first-run setup in the browser"
  else
    ok setup "already set up"
  fi
else
  fail https "https://$domain/api/v1/meta: ${meta:0:200}"
fi

# Plain HTTP must redirect to HTTPS.
code="$(curl -sS -m 10 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$domain/" 2>/dev/null)"
case "$code" in
  30[1278]\ https://*) ok redirect "http → https" ;;
  *) fail redirect "http://$domain/ answered: $code" ;;
esac

# The web app itself.
if curl "${curl_opts[@]}" "https://$domain/" 2>/dev/null | grep -qi '<title>FUDISLTE'; then
  ok web "web app served"
else
  fail web "https://$domain/ does not serve the web app"
fi

exit "$failed"
