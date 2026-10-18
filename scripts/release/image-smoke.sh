#!/usr/bin/env bash
# Starts a Flow image and checks it answers, as an operator would run it.
#
#   DATABASE_URL=postgres://… scripts/release/image-smoke.sh <image> <commit>
#
# DATABASE_URL must be a throwaway PostgreSQL database on this host: the
# container uses the host network and runs its migrations there when it
# starts. GET /health must be ok, reach the database, and report <commit> as
# the revision. The container is removed on exit.
set -euo pipefail

: "${DATABASE_URL:?image-smoke.sh needs DATABASE_URL (a throwaway PostgreSQL database)}"
image="${1:?usage: image-smoke.sh <image> <commit>}"
commit="${2:?usage: image-smoke.sh <image> <commit>}"
port="${FLOW_IMAGE_SMOKE_PORT:-19299}"
name="flow-image-smoke-$$"
cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- container log (last 60 lines)"
    docker logs --tail 60 "$name" 2>&1 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$name" --network host -e DATABASE_URL -e FLOW_PORT="$port" "$image" >/dev/null

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && break
  [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == "true" ]] || { echo "the container exited before it answered /health" >&2; exit 1; }
  sleep 1
done
curl -fsS "http://127.0.0.1:${port}/health" | EXPECTED="$commit" node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const h = JSON.parse(s);
  if (h.ok !== true || h.service !== "flow" || h.database !== true) {
    console.error(`health is not ok: ${s}`);
    process.exit(1);
  }
  if (h.revision !== process.env.EXPECTED) {
    console.error(`health revision is ${h.revision}, expected ${process.env.EXPECTED}`);
    process.exit(1);
  }
  console.log(`health ok, database reachable, revision ${h.revision}`);
});'
if [[ "$(docker exec "$name" id -u)" == "0" ]]; then
  echo "the container runs as root" >&2
  exit 1
fi
echo "runs as a non-root user"
