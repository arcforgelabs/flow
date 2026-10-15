#!/usr/bin/env bash
# Run step of a Replit deployment (.replit run and [deployment] run): start
# the Flow release install-and-verify.sh installed.
#
# Configure it with Replit Secrets (docs/SELF_HOSTING.md, "Replit"):
# FLOW_CONFIG_JSON, DATABASE_URL and the others your installation uses.
set -euo pipefail
cd "$(dirname "$0")"

server="runtime/node_modules/.bin/flow-server"
if [[ ! -x "$server" ]]; then
  echo "[flow] no verified release installed; run install-and-verify.sh first" >&2
  exit 1
fi
export FLOW_PORT="${PORT:-${FLOW_PORT:-19300}}"
# A published Replit app loses its runtime files, so the database must be
# DATABASE_URL.
export FLOW_RUNTIME="${FLOW_RUNTIME:-replit}"
# The release's commit, for Sentry's release and GET /health.
FLOW_REVISION="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("flow.lock","utf8")).commit)')"
export FLOW_REVISION
exec "$server"
