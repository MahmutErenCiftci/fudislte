#!/usr/bin/env bash
# Runs a LiveKit server for development (ADR-0011) in WSL's Docker, on the host network.
# The browser on Windows reaches signalling at ws://localhost:7880 (WSL forwards TCP
# ports) and media at the WSL VM's own address, which Windows can reach directly over
# UDP and TCP; 127.0.0.1 would not work for media, which comes from Windows' own
# interfaces.
#   bash scripts/wsl/dev-livekit.sh        start (or restart)
#   bash scripts/wsl/dev-livekit.sh stop
# The API key and secret are generated once into ~/.config/fudislte/livekit.env, outside
# the repository; scripts/wsl/dev-env.sh hands them to the API.
set -euo pipefail

name=fudislte-livekit
image=livekit/livekit-server:v1.9.4
keys="$HOME/.config/fudislte/livekit.env"

if [ "${1:-start}" = stop ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "stopped $name"
  exit 0
fi

if [ ! -f "$keys" ]; then
  mkdir -p "$(dirname "$keys")"
  (
    umask 077
    printf 'FUDISLTE_LIVEKIT_API_KEY=%s\nFUDISLTE_LIVEKIT_API_SECRET=%s\n' \
      "API$(openssl rand -hex 6)" "$(openssl rand -hex 24)" > "$keys"
  )
fi
# shellcheck disable=SC1090
. "$keys"

node_ip="$(hostname -I | awk '{print $1}')"
config="port: 7880
bind_addresses: [\"127.0.0.1\"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: false
  node_ip: $node_ip
keys:
  $FUDISLTE_LIVEKIT_API_KEY: $FUDISLTE_LIVEKIT_API_SECRET
webhook:
  api_key: $FUDISLTE_LIVEKIT_API_KEY
  urls: [\"http://127.0.0.1:8080/api/v1/media/webhook\"]
logging:
  level: info"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --network host --restart unless-stopped \
  -e LIVEKIT_CONFIG="$config" "$image" >/dev/null
echo "LiveKit running: ws://localhost:7880 (restart the API to pick up the keys)"
