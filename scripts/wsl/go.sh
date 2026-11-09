#!/usr/bin/env bash
# Runs a Go command inside services/api with the WSL toolchain.
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/go.sh test ./...
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin:$HOME/go/bin"
# Keep the build cache on the Linux filesystem; the repository may live on /mnt/c.
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build}"
export FUDISLTE_TEST_DATABASE_URL="${FUDISLTE_TEST_DATABASE_URL:-postgres://fudislte:fudislte@localhost:5432/postgres?sslmode=disable}"
cd "$(dirname "$0")/../../services/api"
exec go "$@"
