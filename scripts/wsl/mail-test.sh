#!/usr/bin/env bash
# Sends one test email with the development SMTP settings from ~/.config/fudislte/dev.env.
#   pnpm mail:test you@company.com
set -euo pipefail
here="$(dirname "$0")"
if [ $# -ne 1 ]; then
  echo "usage: mail-test.sh <recipient@example.com>" >&2
  exit 2
fi
. "$here/dev-env.sh"
exec bash "$here/go.sh" run ./cmd/fudislte-api mailtest "$1"
