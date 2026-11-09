#!/usr/bin/env bash
# Development environment shared by the WSL scripts; source it, do not run it.
#
# Personal settings such as SMTP credentials live in ~/.config/fudislte/dev.env inside
# WSL: outside the repository and outside OneDrive sync. Start from
# scripts/wsl/dev.env.example. Variables set in the shell still win.

personal="$HOME/.config/fudislte/dev.env"
if [ -f "$personal" ]; then
  set -a
  # Strip CR so a file saved by a Windows editor still works.
  # shellcheck disable=SC1090
  . <(tr -d '\r' < "$personal")
  set +a
fi

export FUDISLTE_ENV=development
export FUDISLTE_DATABASE_URL="${FUDISLTE_DATABASE_URL:-postgres://fudislte:fudislte@localhost:5432/fudislte?sslmode=disable}"
export FUDISLTE_HTTP_ADDR="${FUDISLTE_HTTP_ADDR:-127.0.0.1:8080}"
export FUDISLTE_PUBLIC_URL="${FUDISLTE_PUBLIC_URL:-http://localhost:5173}"
export FUDISLTE_COOKIE_SECURE="${FUDISLTE_COOKIE_SECURE:-false}"
export FUDISLTE_LOG_FORMAT="${FUDISLTE_LOG_FORMAT:-text}"
# Without SMTP settings, emails (sign-in codes, invitations) are printed to the API log.
export FUDISLTE_MAIL_TRANSPORT="${FUDISLTE_MAIL_TRANSPORT:-log}"
# Attachments (ADR-0009) on the Linux filesystem, outside the repository.
export FUDISLTE_DATA_DIR="${FUDISLTE_DATA_DIR:-$HOME/.local/share/fudislte}"
# Voice and video (ADR-0011): set when scripts/wsl/dev-livekit.sh has created its keys.
livekit="$HOME/.config/fudislte/livekit.env"
if [ -f "$livekit" ] && [ -z "${FUDISLTE_LIVEKIT_URL:-}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$livekit"
  set +a
  export FUDISLTE_LIVEKIT_URL="ws://localhost:7880"
  export FUDISLTE_LIVEKIT_API_URL="http://127.0.0.1:7880"
fi
