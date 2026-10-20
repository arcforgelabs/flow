#!/usr/bin/env bash
# The Replit deployment's build and run commands (.replit [deployment]).
#
#   scripts/replit-deploy.sh build   # fetch the deploy ref from GitHub into .flow-deploy/ and build it there
#   scripts/replit-deploy.sh start   # start Flow from .flow-deploy/
#   scripts/replit-deploy.sh update-workspace
#                                    # build as above, then bring the workspace's
#                                    # database to the migrations production runs
#                                    # (the Run button)
#   scripts/replit-deploy.sh boot    # start the workspace updater in the background (.replit onBoot)
#   scripts/replit-deploy.sh follow  # the workspace updater: the same, checked every
#                                    # FLOW_WORKSPACE_UPDATE_SECONDS (600)
#
# The workspace updater keeps the workspace's database at exactly the
# migrations production runs (scripts/replit-workspace-db.js, which reads
# production's GET /health), never ahead of it. The two databases then match,
# so Replit's publish step shows no "Development database changes detected";
# if it does, the answer is Cancel (docs/REPLIT.md, "The workspace
# database"). It writes only .flow-deploy/, .flow-workspace/ (its log and
# locks) and .flow-workspace-db/ (production's migrations).
# FLOW_WORKSPACE_UPDATER=off stops it starting.
#
# This script fetches and checks the commit. When the fetched commit's own
# copy of this script can take over (it carries the FLOW_DEPLOY_DRIVER line
# below), that copy builds and migrates, so a fix to those steps reaches an
# installation with the next release, without a git pull in the workspace.
#
# Replit publishes a snapshot of the workspace files. This makes the deployment
# run a commit from GitHub instead: by default the tip of main, or the ref that
# FLOW_DEPLOY_REF names (a branch, a tag or a full commit hash). The fetch is
# anonymous; the repository is public.
#
# FLOW_DEPLOY_REF=stable or beta follows a release channel instead
# (docs/RELEASING.md): the build asks which release the channel points at
# (scripts/deploy-release.js: GitHub's latest release for stable, the newest
# release for beta, with npm's dist-tags as the fallback), checks that
# release's release-manifest.json against its .sha256, fetches its tag, and
# requires the fetched commit to be the one the manifest names. If the
# channel cannot be resolved, the build fails; it never falls back to main.
#
# Before it builds, it asks GitHub whether that commit passed CI
# (scripts/deploy-checks.js): test and gitleaks, the checks the main ruleset
# requires, must have completed with success. Otherwise, or when GitHub cannot
# say (its rate limit, the network), the build fails. A pinned FLOW_DEPLOY_REF is checked
# the same way.
#
# It only ever writes .flow-deploy/ (gitignored). It never resets, checks out
# or deletes the workspace's own files, so it is safe wherever it runs.
#
#   FLOW_DEPLOY_REF=<ref>          deploy this ref instead of main (pin or roll back)
#   FLOW_DEPLOY_REF=stable|beta    deploy the release that channel points at now
#   FLOW_DEPLOY_REPO=<url>         fetch from here (default: the public repository; a fork sets its own)
#   FLOW_DEPLOY_ALLOW_UNCHECKED=1  emergency only: build even when CI did not pass or cannot be read
#   FLOW_DEPLOY_FROM_WORKSPACE=1   emergency only: build the workspace files as they are, no fetch
#                                   (no CI ran on them, so it also needs FLOW_DEPLOY_ALLOW_UNCHECKED=1)
#
# If the fetch fails, the build fails. It never falls back to the workspace copy.
# The build records whether CI passed (.flow-deploy-checks: passed or
# unchecked); start passes it on, and GET /health shows it as build.checks.
set -euo pipefail

# The steps a fetched copy of this script takes over: finish-build and
# migrate-workspace. Keep this line while they keep their arguments.
# FLOW_DEPLOY_DRIVER=2

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A copy that took over runs from inside .flow-deploy/; it is told where that
# is and where the workspace's state is.
OUT="${FLOW_DEPLOY_OUT:-$ROOT/.flow-deploy}"
STATE="${FLOW_WORKSPACE_STATE:-$ROOT/.flow-workspace}"
DEFAULT_REPO="https://github.com/arcforgelabs/flow.git"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] FAILED: $*" >&2; exit 1; }

# A ref is a branch, tag or commit name. Refuse anything git could read as an
# option or a refspec.
valid_ref() { [[ "$1" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] && [[ "$1" != *..* ]]; }

# Runtime state never ships: Flow keeps its records in PostgreSQL
# (DATABASE_URL), never in the build.
remove_runtime_state() {
  rm -rf "$OUT/data" "$OUT/.git"
}

# The workspace files as they are: tracked and new files, uncommitted edits
# included, minus everything .gitignore excludes (data/, node_modules/, config).
copy_workspace() {
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "FLOW_DEPLOY_FROM_WORKSPACE=1 needs the workspace to be a git repository"
  mkdir -p "$OUT"
  local path
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard --deduplicate \
    | while IFS= read -r -d '' path; do
        case "$path" in .flow-deploy|.flow-deploy/*) continue ;; esac
        # Tracked files deleted in the workspace are not copied.
        [ -e "$ROOT/$path" ] || [ -L "$ROOT/$path" ] || continue
        printf '%s\0' "$path"
      done \
    | tar -C "$ROOT" --null -T - -cf - \
    | tar -C "$OUT" -xf -
}

# Did the fetched commit pass CI? Sets checks to passed or unchecked, or fails
# the build.
check_ci() {
  local repo="$1" ref="$2" revision="$3"
  if node "$ROOT/scripts/deploy-checks.js" "$repo" "$revision"; then
    checks=passed
  elif [ "${FLOW_DEPLOY_ALLOW_UNCHECKED:-}" = "1" ]; then
    checks=unchecked
    log "WARNING: FLOW_DEPLOY_ALLOW_UNCHECKED=1: building $ref at $revision although CI did not pass or could not be read. Emergency only; remove it at the next publish"
  else
    rm -rf "$OUT"
    die "$ref at $revision has not passed GitHub CI, so nothing was built. Wait for its checks to pass and publish again, or deploy a commit that passed (FLOW_DEPLOY_REF). In an emergency only, FLOW_DEPLOY_ALLOW_UNCHECKED=1 builds it anyway"
  fi
}

cmd_build() {
  local source ref revision repo checks fetch_ref release="" expected_revision=""
  rm -rf "$OUT"

  if [ "${FLOW_DEPLOY_FROM_WORKSPACE:-}" = "1" ]; then
    [ "${FLOW_DEPLOY_ALLOW_UNCHECKED:-}" = "1" ] \
      || die "FLOW_DEPLOY_FROM_WORKSPACE=1 builds files no CI ran on, so it also needs FLOW_DEPLOY_ALLOW_UNCHECKED=1"
    source=workspace
    checks=unchecked
    ref=workspace
    log "FLOW_DEPLOY_FROM_WORKSPACE=1: building the workspace files as they are, NOT GitHub"
    copy_workspace
    revision="$(git -C "$ROOT" log -1 --format=%H -- . 2>/dev/null || true)"
    if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
      log "the workspace has uncommitted changes; they are in this build, so ${revision:-its commit} is only its base"
    fi
  else
    source=github
    ref="${FLOW_DEPLOY_REF:-main}"
    repo="${FLOW_DEPLOY_REPO:-$DEFAULT_REPO}"
    valid_ref "$ref" || die "FLOW_DEPLOY_REF '$ref' is not a branch, tag or full commit hash"
    fetch_ref="$ref"
    if [ "$ref" = stable ] || [ "$ref" = beta ]; then
      local resolved
      if ! resolved="$(node "$ROOT/scripts/deploy-release.js" "$repo" "$ref")"; then
        rm -rf "$OUT"
        die "could not tell which release the $ref channel points at, so nothing was built and main is not deployed instead. Publish again later, or pin FLOW_DEPLOY_REF to a release tag such as v2026.10.15"
      fi
      release="${resolved%% *}"
      expected_revision="${resolved##* }"
      valid_ref "$release" || die "the $ref channel named '$release', which is not a tag"
      fetch_ref="refs/tags/$release"
      log "the $ref channel is $release"
    elif [[ "$ref" =~ ^v20[0-9]{2}\.[0-9]{1,2}\.[0-9]+(-beta\.[0-9]+|-[0-9]+)?$ ]]; then
      release="$ref"
    fi
    log "fetching ${release:-$ref} from $repo"
    mkdir -p "$OUT"
    git -C "$OUT" init -q
    if ! GIT_TERMINAL_PROMPT=0 git -C "$OUT" -c credential.helper= \
        fetch -q --depth 1 --no-tags "$repo" "$fetch_ref"; then
      rm -rf "$OUT"
      die "could not fetch '$ref' from $repo. Nothing was built and the workspace copy is not deployed instead. Check the ref and the network, or set FLOW_DEPLOY_FROM_WORKSPACE=1 for an emergency build of the workspace files"
    fi
    git -C "$OUT" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
    revision="$(git -C "$OUT" rev-parse HEAD)"
    log "fetched ${release:-$ref} at $revision"
    if [ -n "$expected_revision" ] && [ "$revision" != "$expected_revision" ]; then
      rm -rf "$OUT"
      die "$release is at $revision, but its release-manifest.json names $expected_revision. Nothing was built"
    fi
    # .replit and this script come from the workspace, not from the fetched
    # commit. Say so when they differ, so the workspace can be pulled.
    local f
    for f in .replit scripts/replit-deploy.sh scripts/deploy-checks.js scripts/deploy-release.js server/release-channel.js; do
      if ! cmp -s "$ROOT/$f" "$OUT/$f"; then
        log "note: $f in the workspace differs from $ref; the workspace copy ran this build. Pull main into the workspace (git pull) to use the new one"
      fi
    done
    check_ci "$repo" "$ref" "$revision"
  fi

  if [ "$source" = github ] && takes_over; then
    log "the fetched $ref builds itself (its scripts/replit-deploy.sh)"
    handed_over finish-build "$source" "$ref" "$revision" "$release" "$checks" || exit $?
  else
    cmd_finish_build "$source" "$ref" "$revision" "$release" "$checks"
  fi
}

# Can the fetched commit's copy of this script take over the build and the
# migration? Only a copy that says so: an older release builds the old way.
takes_over() {
  [ "${FLOW_DEPLOY_HANDED_OVER:-}" != "1" ] \
    && [ -f "$OUT/scripts/replit-deploy.sh" ] \
    && grep -qx '# FLOW_DEPLOY_DRIVER=2' "$OUT/scripts/replit-deploy.sh"
}

handed_over() {
  FLOW_DEPLOY_HANDED_OVER=1 FLOW_DEPLOY_OUT="$OUT" FLOW_WORKSPACE_STATE="$STATE" \
    bash "$OUT/scripts/replit-deploy.sh" "$@"
}

# Builds the fetched commit in .flow-deploy/ and records what it is.
cmd_finish_build() {
  local source="$1" ref="$2" revision="$3" release="$4" checks="$5"
  [ -f "$OUT/scripts/replit-build.sh" ] || die "$ref has no scripts/replit-build.sh to build with"
  log "building $source $ref${revision:+ at $revision}"
  (cd "$OUT" && bash scripts/replit-build.sh) || die "the build of $ref failed"

  remove_runtime_state
  if [ -n "$revision" ]; then
    printf '%s\n' "$revision" > "$OUT/.flow-revision"
  else
    rm -f "$OUT/.flow-revision"
  fi
  printf '%s\n' "$ref" > "$OUT/.flow-deploy-ref"
  if [ -n "$release" ]; then
    printf '%s\n' "$release" > "$OUT/.flow-deploy-release"
  else
    rm -f "$OUT/.flow-deploy-release"
  fi
  printf '%s\n' "$source" > "$OUT/.flow-deploy-source"
  printf '%s\n' "$checks" > "$OUT/.flow-deploy-checks"
  log "built $source $ref${release:+ ($release)} at ${revision:-an unknown commit} into .flow-deploy/ (checks: $checks)"
}

cmd_start() {
  if [ ! -f "$OUT/.flow-deploy-source" ] || [ ! -f "$OUT/scripts/replit-start.sh" ]; then
    die "no deployment build in .flow-deploy/; the deployment build command is 'bash scripts/replit-deploy.sh build'"
  fi
  local built_ref source revision checks release
  built_ref="$(cat "$OUT/.flow-deploy-ref")"
  release="$(cat "$OUT/.flow-deploy-release" 2>/dev/null || true)"
  source="$(cat "$OUT/.flow-deploy-source")"
  revision="$(cat "$OUT/.flow-revision" 2>/dev/null || true)"
  # A build from before the CI check has no record: it was not checked.
  checks="$(cat "$OUT/.flow-deploy-checks" 2>/dev/null || echo unchecked)"
  if [ "$source" = github ] && [ "${FLOW_DEPLOY_REF:-main}" != "$built_ref" ]; then
    log "WARNING: FLOW_DEPLOY_REF is '${FLOW_DEPLOY_REF:-main}' now, but this build fetched '$built_ref'. Publish again to deploy it"
  fi
  if [ "$source" = github ] && [ "${FLOW_DEPLOY_FROM_WORKSPACE:-}" = "1" ]; then
    log "WARNING: FLOW_DEPLOY_FROM_WORKSPACE=1 is set now, but this build fetched '$built_ref' from GitHub. Publish again to deploy the workspace"
  fi
  log "starting $source $built_ref${release:+ ($release)} at ${revision:-an unknown commit} (checks: $checks)"
  export FLOW_DEPLOYED_REF="$built_ref"
  # The release tag this build is, when it is one; GET /health shows it.
  if [ -n "$release" ]; then export FLOW_DEPLOYED_RELEASE="$release"; else unset FLOW_DEPLOYED_RELEASE; fi
  export FLOW_DEPLOYED_FROM="$source"
  export FLOW_DEPLOYED_CHECKS="$checks"
  # The commit this build is, whatever the environment says.
  if [ -n "$revision" ]; then export FLOW_REVISION="$revision"; else unset FLOW_REVISION; fi
  exec bash "$OUT/scripts/replit-start.sh"
}

# The workspace's Run button (.replit run). It builds what the next publish
# will build, then, with that build's tools, brings the workspace's database
# to the migrations production runs, and stops; it starts no server and never
# migrates the workspace past production (docs/REPLIT.md, "The workspace
# database"). One at a time: a second run waits for the first.
cmd_update_workspace() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set; add the workspace's Replit PostgreSQL database"
  mkdir -p "$STATE"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$STATE/update.lock"
    flock -w 1800 9 || die "another update of the workspace is still running"
  fi
  cmd_build
  follow_production
}

# Runs migrate-workspace with the build's own copy of this script when it can
# take over, else with this one.
follow_production() {
  if takes_over; then
    handed_over migrate-workspace || exit $?
  else
    cmd_migrate_workspace
  fi
}

# Brings the workspace's database to the migrations production runs, with
# the build's scripts/replit-workspace-db.js (it needs the build's packages).
# The name is kept for the workspace copies that hand this step over
# (FLOW_DEPLOY_DRIVER=2); it no longer migrates to the build.
cmd_migrate_workspace() {
  local built status=0
  built="$(cat "$OUT/.flow-deploy-release" 2>/dev/null || cat "$OUT/.flow-deploy-ref")"
  [ -f "$OUT/scripts/replit-workspace-db.js" ] \
    || die "$built has no scripts/replit-workspace-db.js, so the workspace database cannot follow production. Set FLOW_DEPLOY_REF to stable"
  log "bringing the workspace database to the migrations production runs"
  (cd "$OUT" && node scripts/replit-workspace-db.js sync) || status=$?
  case "$status" in
    0) log "the workspace database matches production. Publish: Replit shows no database changes. If it shows 'Development database changes detected', press Cancel" ;;
    3) log "WARNING: the workspace database is not production's (above). Nothing was changed. If Replit shows 'Development database changes detected', press Cancel"
       return 3 ;;
    *) die "the workspace database could not follow production (above). If Replit shows 'Development database changes detected', press Cancel" ;;
  esac
}

# Which commit FLOW_DEPLOY_REF names now, without fetching it.
target_revision() {
  local ref="${FLOW_DEPLOY_REF:-main}" repo="${FLOW_DEPLOY_REPO:-$DEFAULT_REPO}" resolved
  valid_ref "$ref" || return 1
  if [ "$ref" = stable ] || [ "$ref" = beta ]; then
    resolved="$(node "$ROOT/scripts/deploy-release.js" "$repo" "$ref")" || return 1
    printf '%s\n' "${resolved##* }"
  elif [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$ref"
  else
    # A tag's own commit (^{}) when it is annotated, else the ref's.
    GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote "$repo" "$ref" "$ref^{}" 2>/dev/null \
      | awk '{ if ($2 ~ /\^\{\}$/) peeled = $1; else if (!first) first = $1 } END { r = peeled ? peeled : first; if (!r) exit 1; print r }'
  fi
}

# One step of the workspace updater: bring the workspace's database to the
# migrations production runs. It builds FLOW_DEPLOY_REF again only when that
# names a new commit; the build supplies the tools.
cmd_sync_workspace() {
  if [ -z "${DATABASE_URL:-}" ]; then log "no DATABASE_URL, so there is no workspace database to update"; return 0; fi
  if [ "${FLOW_DEPLOY_FROM_WORKSPACE:-}" = "1" ]; then log "FLOW_DEPLOY_FROM_WORKSPACE=1: the workspace updater does nothing"; return 0; fi
  local target followed=0
  # Follow production first with the build already here: a new build takes
  # minutes, and a publish pressed meanwhile would compare a database that
  # is still behind. replit-workspace-db.js fetches production's own
  # migrations, so an older build's tools can follow a newer production.
  if [ -f "$OUT/.flow-revision" ] && [ -f "$OUT/scripts/replit-workspace-db.js" ]; then
    mkdir -p "$STATE"
    if ( if command -v flock >/dev/null 2>&1; then
           exec 9>"$STATE/update.lock"
           flock -w 1800 9 || die "another update of the workspace is still running"
         fi
         follow_production ); then
      followed=1
    fi
  fi
  target="$(target_revision)" || { log "could not tell which commit ${FLOW_DEPLOY_REF:-main} names now; trying again later"; return 1; }
  if [ -f "$OUT/.flow-revision" ] && [ "$(cat "$OUT/.flow-revision")" = "$target" ]; then
    [ "$followed" = 1 ] && return 0
    mkdir -p "$STATE"
    if command -v flock >/dev/null 2>&1; then
      exec 9>"$STATE/update.lock"
      flock -w 1800 9 || die "another update of the workspace is still running"
    fi
    follow_production
  else
    log "${FLOW_DEPLOY_REF:-main} is at $target; building it for its tools"
    cmd_update_workspace
  fi
}

# The workspace updater. One per workspace; each step runs on its own, so a
# failed step is logged and the next one tries again.
cmd_follow() {
  mkdir -p "$STATE"
  if command -v flock >/dev/null 2>&1; then
    exec 8>"$STATE/follow.lock"
    flock -n 8 || { log "the workspace updater is already running"; return 0; }
  fi
  local interval="${FLOW_WORKSPACE_UPDATE_SECONDS:-600}"
  [[ "$interval" =~ ^[0-9]+$ ]] && [ "$interval" -ge 60 ] || interval=600
  while :; do
    log "$(date -u +%Y-%m-%dT%H:%M:%SZ) checking ${FLOW_DEPLOY_REF:-main}"
    ( cmd_sync_workspace ) 8>&- || log "this check failed; the next is in ${interval}s"
    [ "${FLOW_WORKSPACE_UPDATE_ONCE:-}" = "1" ] && break
    sleep "$interval"
  done
}

# .replit onBoot: starts the workspace updater in the background, so the
# workspace opens at once. Its log is .flow-workspace/updater.log.
cmd_boot() {
  if [ "${FLOW_WORKSPACE_UPDATER:-on}" = "off" ]; then log "FLOW_WORKSPACE_UPDATER=off: the workspace updater does not start"; return 0; fi
  mkdir -p "$STATE"
  local logfile="$STATE/updater.log"
  # Keep the log short: start it again when it passes 1 MB.
  if [ -f "$logfile" ] && [ "$(wc -c < "$logfile")" -gt 1048576 ]; then mv -f "$logfile" "$logfile.1"; fi
  local detach=()
  if command -v setsid >/dev/null 2>&1; then detach=(setsid); fi
  nohup "${detach[@]}" bash "$ROOT/scripts/replit-deploy.sh" follow >>"$logfile" 2>&1 </dev/null &
  log "the workspace updater started; its log is .flow-workspace/updater.log"
}

case "${1:-}" in
  build) cmd_build ;;
  start) cmd_start ;;
  update-workspace) cmd_update_workspace ;;
  boot) cmd_boot ;;
  follow) cmd_follow ;;
  # The steps a fetched copy takes over (takes_over above).
  finish-build) shift; cmd_finish_build "$@" ;;
  migrate-workspace) cmd_migrate_workspace ;;
  *) echo "usage: $0 build|start|update-workspace|boot|follow" >&2; exit 2 ;;
esac
