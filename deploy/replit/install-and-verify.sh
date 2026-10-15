#!/usr/bin/env bash
# Build step of a Replit deployment (.replit [deployment] build): install the
# Flow release flow.lock pins, and refuse it unless it verifies.
#
# 1. npm installs @arcforgelabs/flow at exactly flow.lock's version into
#    runtime/. The package's shrinkwrap pins every dependency.
# 2. `npm audit signatures` checks the registry signatures and the provenance
#    attestation cryptographically.
# 3. verify-release.mjs checks the installed integrity against flow.lock,
#    and that the provenance names flow.lock's commit, the Flow repository
#    and its release workflow.
#
# Any failure fails the build, so Replit keeps running the previous
# deployment. Nothing here needs a secret.
set -euo pipefail
cd "$(dirname "$0")"

version="$(node verify-release.mjs version)"
echo "[flow] installing @arcforgelabs/flow@${version}"
rm -rf runtime
mkdir runtime
# Replit's package firewall needs the lockfile's own URLs (.npmrc explains).
cp .npmrc runtime/.npmrc
cat > runtime/package.json <<JSON
{ "private": true, "dependencies": { "@arcforgelabs/flow": "${version}" } }
JSON
(cd runtime && npm install --omit=dev --no-audit --no-fund --save-exact)
(cd runtime && npm audit signatures)
node verify-release.mjs verify runtime
