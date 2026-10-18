#!/usr/bin/env bash
# Start Flow on Replit. Replit routes external port 80 to PORT (19300 in .replit).
set -euo pipefail
cd "$(dirname "$0")/.."
export FLOW_PORT="${PORT:-${FLOW_PORT:-19300}}"
# A published Replit app loses its runtime files, so the database must be
# DATABASE_URL (a Replit PostgreSQL database or your own).
export FLOW_RUNTIME="${FLOW_RUNTIME:-replit}"
# The build's git commit (scripts/replit-build.sh), for GET /health.
if [ -z "${FLOW_REVISION:-}" ] && [ -s .flow-revision ]; then
  export FLOW_REVISION="$(cat .flow-revision)"
fi
exec node server/index.js
