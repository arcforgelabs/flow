#!/usr/bin/env bash
# Installs a packed @arcforgelabs/flow tarball the way an operator would, in
# an empty directory, then starts it and checks it answers.
#
#   DATABASE_URL=postgres://… scripts/release/package-smoke.sh <tarball>
#
# DATABASE_URL must be a throwaway PostgreSQL database: `flow-server` runs its
# migrations there when it starts. It starts `flow-server` from the install
# and requires GET /health to be ok with the database reachable, and its
# build.release to be the package's version. Everything
# else lives in a temporary directory that is removed on exit.
set -euo pipefail

: "${DATABASE_URL:?package-smoke.sh needs DATABASE_URL (a throwaway PostgreSQL database)}"
tarball="$(cd "$(dirname "${1:?usage: package-smoke.sh <tarball>}")" && pwd)/$(basename "$1")"
work="$(mktemp -d)"
port="${FLOW_PACKAGE_SMOKE_PORT:-19298}"
server_pid=""
cleanup() {
  status=$?
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ $status -ne 0 && -f "$work/server.log" ]]; then
    echo "--- flow-server log (last 60 lines)"
    tail -n 60 "$work/server.log"
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

cd "$work"
npm init -y >/dev/null
npm install --omit=dev --no-audit --no-fund "$tarball"
installed="$work/node_modules/@arcforgelabs/flow"
test -f "$installed/server/db/migrations/0000_core.sql"
test -f "$installed/npm-shrinkwrap.json"
test ! -e "$installed/test"

FLOW_PORT="$port" "$work/node_modules/.bin/flow-server" > "$work/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && break
  kill -0 "$server_pid" 2>/dev/null || { echo "flow-server exited before it answered /health" >&2; exit 1; }
  sleep 1
done
expected_release="v$(node -p 'require(process.argv[1]).version' "$installed/package.json")"
curl -fsS "http://127.0.0.1:${port}/health" | EXPECTED="$expected_release" node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const h = JSON.parse(s);
  if (h.ok !== true || h.service !== "flow" || h.database !== true) {
    console.error(`health is not ok: ${s}`);
    process.exit(1);
  }
  if (h.build?.release !== process.env.EXPECTED) {
    console.error(`health build.release is ${h.build?.release}, expected ${process.env.EXPECTED}`);
    process.exit(1);
  }
  console.log(`health ok, database reachable, release ${h.build.release}`);
});'
