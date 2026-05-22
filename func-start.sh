#!/usr/bin/env bash
# Starts Azurite (storage emulator) then `func start` — one command for local timer runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

rm -f __azurite_db_*.json 2>/dev/null || true
mkdir -p .azurite-data

if lsof -i :10000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[func-start] Port 10000 already in use — assuming Azurite is running."
  AZURITE_PID=""
else
  echo "[func-start] Starting Azurite..."
  if [[ -x "$ROOT/node_modules/.bin/azurite" ]]; then
    "$ROOT/node_modules/.bin/azurite" --silent --location "$ROOT/.azurite-data" --blobPort 10000 --queuePort 10001 --tablePort 10002 &
  else
    npx --yes azurite --silent --location "$ROOT/.azurite-data" --blobPort 10000 --queuePort 10001 --tablePort 10002 &
  fi
  AZURITE_PID=$!

  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "http://127.0.0.1:10000/devstoreaccount1?comp=list" 2>/dev/null; then
      echo "[func-start] Azurite is ready."
      break
    fi
    sleep 0.25
  done
fi

cleanup() {
  if [[ -n "${AZURITE_PID:-}" ]]; then
    echo "[func-start] Stopping Azurite..."
    kill "$AZURITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[func-start] Running func start..."
func start "$@"
EXIT_CODE=$?
exit "$EXIT_CODE"
