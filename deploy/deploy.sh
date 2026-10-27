#!/usr/bin/env bash
# Update the showcase demo on the server: pull, build, restart, check.
#
# The running container keeps serving while the new image builds; the switch itself
# takes a few seconds. Refuses to run during a freeze window (training sessions on the
# same host), unless FORCE=1.
#
#   ./deploy/deploy.sh                      # normal update
#   DEMO_FREEZE="2027-03-01:2027-03-05" ./deploy/deploy.sh
#   FORCE=1 ./deploy/deploy.sh              # deliberate update inside a freeze window
set -euo pipefail

cd "$(dirname "$0")/.."

# Freeze windows: START:END (inclusive, YYYY-MM-DD), comma separated.
FREEZE="${DEMO_FREEZE:-2026-12-07:2026-12-11}"
PORT="${DEMO_HOST_PORT:-8020}"
today="$(date +%F)"

IFS=',' read -r -a windows <<< "$FREEZE"
for window in "${windows[@]}"; do
  start="${window%%:*}"
  end="${window##*:}"
  if [[ ! "$today" < "$start" && ! "$today" > "$end" ]]; then
    if [[ "${FORCE:-0}" != "1" ]]; then
      echo "Freeze window $start to $end: no deployment today ($today). Use FORCE=1 to override." >&2
      exit 1
    fi
    echo "Freeze window $start to $end overridden with FORCE=1." >&2
  fi
done

echo "==> Pulling the latest code"
git pull --ff-only

echo "==> Building the image (the current container keeps serving meanwhile)"
docker compose build --pull

echo "==> Restarting the container"
docker compose up -d

echo "==> Waiting for the health check"
status="starting"
for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' mutuelle-exemple-fraude 2>/dev/null || echo missing)"
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
if [[ "$status" != "healthy" ]]; then
  echo "Container is $status. Last log lines:" >&2
  docker compose logs --tail 40 demo >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:${PORT}/health"
echo
echo "==> Removing dangling images"
docker image prune -f > /dev/null
echo "Done: the demo answers on 127.0.0.1:${PORT}."
