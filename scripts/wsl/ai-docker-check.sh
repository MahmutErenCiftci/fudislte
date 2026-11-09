#!/usr/bin/env bash
# Verifies the AI worker's container setup (ADR-0012) with Docker inside WSL, without
# touching any running stack (everything here is named fudislte-aicheck-*):
#   1. `docker compose config` of compose.yml + compose.ai.yml with a temporary env file;
#   2. builds the image fudislte/ai:dev;
#   3. runs it read-only and unprivileged and checks /healthz and request signing;
#   4. end to end: worker + pgvector/pgvector image + a fake Ollama (no model download),
#      requests signed with openssl, ACL-filtered search and citation checks.
#
#   wsl -d Ubuntu-24.04 -- bash scripts/wsl/ai-docker-check.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
docker_dir="$root/infrastructure/docker"
service="$root/services/ai"
port=18090
secret="$(openssl rand -hex 32)"
work="$(mktemp -d)"
names=(fudislte-aicheck-smoke fudislte-aicheck-ai fudislte-aicheck-db fudislte-aicheck-llm)

cleanup() {
  docker rm -f -v "${names[@]}" >/dev/null 2>&1 || true
  docker network rm fudislte-aicheck >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

json_check() { # python expression over `d` (the JSON on stdin) that must be true
  python3 -c "import json,sys; d=json.load(sys.stdin); assert $1, d" || { echo "FAILED: $1" >&2; exit 1; }
}

# v1 signature: HMAC-SHA256 over timestamp.METHOD.target.body (docs/architecture/ai-worker.md §3).
signature() { # timestamp method target body
  printf '%s.%s.%s.%s' "$1" "$2" "$3" "$4" | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1
}

signed() { # method target body
  local ts
  ts="$(date +%s)"
  curl -sS -X "$1" "http://127.0.0.1:$port$2" -H "Content-Type: application/json" \
    -H "X-FUDISLTE-Timestamp: $ts" -H "X-FUDISLTE-Signature: v1=$(signature "$ts" "$1" "$2" "$3")" --data-binary "$3"
}

wait_healthy() {
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  docker logs "$1" >&2 || true
  return 1
}

echo "== 1. compose config"
cat > "$work/env" <<EOF
FUDISLTE_DOMAIN=fudislte.example.com
POSTGRES_PASSWORD=$(openssl rand -hex 16)
FUDISLTE_AI_SHARED_SECRET=$secret
FUDISLTE_AI_POSTGRES_PASSWORD=$(openssl rand -hex 16)
EOF
compose() { docker compose -p fudislte-aicheck --env-file "$work/env" -f "$docker_dir/compose.yml" -f "$docker_dir/compose.ai.yml" "$@"; }
compose config --quiet
compose --profile ollama config --format json > "$work/config.json"
json_check '"ports" not in d["services"]["ai"] and "ports" not in d["services"]["ai-postgres"] and "ports" not in d["services"]["ollama"]' < "$work/config.json"
json_check 'set(d["services"]["api"]["networks"]) == {"backend", "edge", "ai"}' < "$work/config.json"
json_check 'set(d["services"]["ai"]["networks"]) == {"ai", "ai-backend"} and set(d["services"]["ai-postgres"]["networks"]) == {"ai-backend"}' < "$work/config.json"
json_check 'd["networks"]["ai"]["internal"] and d["networks"]["ai-backend"]["internal"]' < "$work/config.json"
json_check 'd["services"]["api"]["environment"]["FUDISLTE_AI_URL"] == "http://ai:8090" and d["services"]["api"]["environment"]["FUDISLTE_AI_SHARED_SECRET"]' < "$work/config.json"
json_check 'd["services"]["ai"]["read_only"] and d["services"]["ai"]["cap_drop"] == ["ALL"] and "ai" not in d["services"]["api"].get("depends_on", {})' < "$work/config.json"
grep -v FUDISLTE_AI_SHARED_SECRET "$work/env" > "$work/env-missing"
if docker compose -p fudislte-aicheck --env-file "$work/env-missing" -f "$docker_dir/compose.yml" -f "$docker_dir/compose.ai.yml" config --quiet 2>"$work/err"; then
  echo "FAILED: config without FUDISLTE_AI_SHARED_SECRET was accepted" >&2; exit 1
fi
grep -q "set FUDISLTE_AI_SHARED_SECRET" "$work/err"
echo "compose config: ok (ai has no published ports, internal networks, api not dependent on ai)"

echo "== 2. docker build"
if ! timeout 900 docker build -f "$service/Dockerfile" -t fudislte/ai:dev "$root" >"$work/build.log" 2>&1; then
  tail -40 "$work/build.log" >&2
  exit 1
fi
docker image inspect fudislte/ai:dev --format 'image: {{.Id}} user={{.Config.User}} size={{.Size}}'

hardened=(--read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true)

echo "== 3. smoke: healthz and signatures"
docker run -d --name fudislte-aicheck-smoke "${hardened[@]}" -p "127.0.0.1:$port:8090" \
  -e FUDISLTE_AI_SHARED_SECRET="$secret" fudislte/ai:dev >/dev/null
wait_healthy fudislte-aicheck-smoke
curl -fsS "http://127.0.0.1:$port/healthz" | tee "$work/h.json"; echo
json_check 'd["status"] == "ok" and d["capabilities"] == {"llm": False, "embeddings": False, "transcription": False}' < "$work/h.json"
docker exec fudislte-aicheck-smoke python -m fudislte_ai healthcheck && echo "healthcheck command: ok"
docker inspect fudislte-aicheck-smoke --format 'readonly={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}} capdrop={{.HostConfig.CapDrop}}'
body='{"kind":"meeting","locale":"en","items":[{"id":"m1","text":"hi"}]}'
signed POST /v1/summarize "$body" | json_check 'd["error"]["code"] == "capability_disabled"'
curl -sS -X POST "http://127.0.0.1:$port/v1/summarize" --data-binary "$body" | json_check 'd["error"]["code"] == "signature_missing"'
old=$(( $(date +%s) - 400 ))
curl -sS -X POST "http://127.0.0.1:$port/v1/summarize" -H "X-FUDISLTE-Timestamp: $old" \
  -H "X-FUDISLTE-Signature: v1=$(signature "$old" POST /v1/summarize "$body")" \
  --data-binary "$body" | json_check 'd["error"]["code"] == "timestamp_expired"'
# A valid signature replayed to another path, method or query string is refused.
now="$(date +%s)"
sig="v1=$(signature "$now" POST /v1/summarize "$body")"
curl -sS -X POST "http://127.0.0.1:$port/v1/suggest-tasks" -H "X-FUDISLTE-Timestamp: $now" -H "X-FUDISLTE-Signature: $sig" \
  --data-binary "$body" | json_check 'd["error"]["code"] == "signature_invalid"'
curl -sS -X PUT "http://127.0.0.1:$port/v1/summarize" -H "X-FUDISLTE-Timestamp: $now" -H "X-FUDISLTE-Signature: $sig" \
  --data-binary "$body" | json_check 'd["error"]["code"] == "signature_invalid"'
curl -sS -X POST "http://127.0.0.1:$port/v1/summarize?x=1" -H "X-FUDISLTE-Timestamp: $now" -H "X-FUDISLTE-Signature: $sig" \
  --data-binary "$body" | json_check 'd["error"]["code"] == "signature_invalid"'
signed GET "/v1/agents/runs/abc?x=1" "" | json_check 'd["error"]["code"] == "run_not_found"'
echo "smoke: ok (openssl-signed requests accepted; unsigned, stale and replayed-elsewhere requests refused)"
docker rm -f fudislte-aicheck-smoke >/dev/null

echo "== 4. end to end with pgvector/pgvector:0.8.7-pg17 and a fake Ollama"
db_pw="$(openssl rand -hex 16)"
docker network create --internal fudislte-aicheck >/dev/null
docker run -d --name fudislte-aicheck-db --network fudislte-aicheck -e POSTGRES_DB=fudislte_ai \
  -e POSTGRES_USER=fudislte_ai -e POSTGRES_PASSWORD="$db_pw" pgvector/pgvector:0.8.7-pg17 >/dev/null
docker run -d --name fudislte-aicheck-llm --network fudislte-aicheck "${hardened[@]}" \
  -v "$service/tests/fake_ollama.py:/fake/fake_ollama.py:ro" --entrypoint python fudislte/ai:dev /fake/fake_ollama.py 11434 >/dev/null
for _ in $(seq 1 60); do
  docker exec fudislte-aicheck-db pg_isready -q -U fudislte_ai -d fudislte_ai 2>/dev/null && break
  sleep 1
done
# The internal network has no host port; the worker also joins the default bridge only
# so this script can reach it on 127.0.0.1.
docker create --name fudislte-aicheck-ai --network fudislte-aicheck "${hardened[@]}" -p "127.0.0.1:$port:8090" \
  -e FUDISLTE_AI_SHARED_SECRET="$secret" -e FUDISLTE_AI_LLM_KIND=ollama -e FUDISLTE_AI_LLM_URL=http://fudislte-aicheck-llm:11434 \
  -e FUDISLTE_AI_LLM_MODEL=fake -e FUDISLTE_AI_EMBED_MODEL=fake-embed -e FUDISLTE_AI_EMBED_DIM=8 \
  -e FUDISLTE_AI_DATABASE_URL="postgres://fudislte_ai:$db_pw@fudislte-aicheck-db:5432/fudislte_ai?sslmode=disable" \
  fudislte/ai:dev >/dev/null
docker network connect bridge fudislte-aicheck-ai
docker start fudislte-aicheck-ai >/dev/null
wait_healthy fudislte-aicheck-ai
curl -fsS "http://127.0.0.1:$port/healthz" | json_check 'd["capabilities"] == {"llm": True, "embeddings": True, "transcription": False}'
for doc in 'a|channel:general|budget forecast for next quarter' 'b|channel:management|budget forecast salaries are confidential'; do
  IFS='|' read -r id acl text <<<"$doc"
  signed POST /v1/index "{\"orgId\":\"org1\",\"sourceType\":\"message\",\"sourceId\":\"$id\",\"aclId\":\"$acl\",\"title\":\"\",\"text\":\"$text\",\"updatedAt\":\"2026-10-30T10:00:00Z\"}" \
    | json_check 'd == {"status": "indexed", "chunks": 1}'
done
signed POST /v1/search '{"orgId":"org1","query":"budget forecast","allowedAclIds":["channel:general"],"limit":10}' \
  | json_check '[r["sourceId"] for r in d["results"]] == ["a"]'
signed POST /v1/search '{"orgId":"org1","query":"budget forecast","allowedAclIds":["channel:general","channel:management"],"limit":10}' \
  | json_check 'sorted(r["sourceId"] for r in d["results"]) == ["a", "b"]'
signed POST /v1/search '{"orgId":"org2","query":"budget forecast","allowedAclIds":["channel:general"],"limit":10}' \
  | json_check 'd["results"] == []'
signed POST /v1/summarize '{"kind":"meeting","locale":"en","items":[{"id":"m1","author":"Dana","text":"We ship on Friday."}]}' \
  | json_check 'd["decisions"] == [{"text": "Real decision", "citations": ["m1"]}] and d["dropped"]["decisions"] == 1'
signed DELETE /v1/index '{"orgId":"org1"}' | json_check 'd == {"deleted": 2}'
docker exec fudislte-aicheck-db psql -U fudislte_ai -d fudislte_ai -tAc \
  "SELECT 'pgvector ' || extversion FROM pg_extension WHERE extname = 'vector'"
echo "end to end: ok (index, ACL-filtered search, cross-org isolation, citation check, delete)"
echo "ALL CHECKS PASSED"
