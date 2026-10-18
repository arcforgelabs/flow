#!/usr/bin/env bash
# Build Flow on Replit: install the production dependencies the lockfile pins.
# scripts/replit-deploy.sh runs this inside the commit it fetched.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --omit=dev --no-audit --no-fund
# The commit this build is (scripts/replit-start.sh). Path-limited, so
# Replit's empty "Published your App" commits are skipped.
git log -1 --format=%H -- . > .flow-revision 2>/dev/null || rm -f .flow-revision
