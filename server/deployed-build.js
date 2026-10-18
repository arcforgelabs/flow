// What build is running, for GET /health: the git commit (FLOW_REVISION),
// and on a Replit deployment the ref it was fetched as and where it came from
// ("github", or "workspace" for an emergency build), and whether its GitHub CI
// passed before it was built ("passed", or "unchecked" when an emergency
// override built it anyway), which scripts/replit-deploy.sh sets, and the
// release tag the build is (FLOW_DEPLOYED_RELEASE from that deploy, or
// FLOW_RELEASE, which server/flow-server.js sets for an installed npm
// package and the Dockerfile sets for a release image), when it is one. The
// repository is public, so none of these is a secret. Each is null when
// unknown.
export function deployedBuildStatus(env = process.env) {
  const read = (value) => String(value ?? "").trim() || null;
  return {
    revision: read(env.FLOW_REVISION),
    ref: read(env.FLOW_DEPLOYED_REF),
    source: read(env.FLOW_DEPLOYED_FROM),
    checks: read(env.FLOW_DEPLOYED_CHECKS),
    release: read(env.FLOW_DEPLOYED_RELEASE) ?? read(env.FLOW_RELEASE),
  };
}
