#!/usr/bin/env bash
# Installs Mailpit (MIT), a local SMTP server with a web inbox, for development.
#   wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/install-mailpit.sh
# Run it with:  mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
# then open http://localhost:8025 on Windows.
set -euo pipefail

VERSION="v1.32.0"
SHA256="4b5993c978e8604c70d43927e2ad103b311bba3b1822fa0cf1d4ee4ec890a93c"

if /usr/local/bin/mailpit version 2>/dev/null | grep -q "${VERSION}"; then
  echo "Mailpit ${VERSION} already installed"
  exit 0
fi
tmp="$(mktemp -d)"
curl -fsSL -o "${tmp}/mailpit.tar.gz" "https://github.com/axllent/mailpit/releases/download/${VERSION}/mailpit-linux-amd64.tar.gz"
echo "${SHA256}  ${tmp}/mailpit.tar.gz" | sha256sum -c - >/dev/null
tar -C "${tmp}" -xzf "${tmp}/mailpit.tar.gz" mailpit
install -m 0755 "${tmp}/mailpit" /usr/local/bin/mailpit
rm -rf "${tmp}"
/usr/local/bin/mailpit version
