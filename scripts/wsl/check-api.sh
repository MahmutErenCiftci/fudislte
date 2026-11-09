#!/usr/bin/env bash
# Formats, vets and tests the Go API against the WSL PostgreSQL server.
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/check-api.sh [go test flags]
set -euo pipefail
here="$(dirname "$0")"
export PATH="$PATH:/usr/local/go/bin"

unformatted="$(cd "$here/../../services/api" && gofmt -l .)"
if [ -n "$unformatted" ]; then
  echo "gofmt needed:" >&2
  echo "$unformatted" >&2
  exit 1
fi
bash "$here/go.sh" vet ./...
bash "$here/go.sh" test -count=1 "$@" ./... 2>&1 | grep -v '"migration applied"\|msg="migration applied"'
exit "${PIPESTATUS[0]}"
