# Self-hosting Flow

Run a published Flow release, not a branch of this repository. Each
installation pins one release by version and fingerprint, checks it before it
runs, and upgrades by changing the pin. This is the same model as
[Field](https://github.com/arcforgelabs/field/blob/main/docs/SELF_HOSTING.md).

Flow needs a PostgreSQL database, given as `DATABASE_URL`. The server runs
its migrations when it starts (`docs/DATA_MODEL.md`).

Flow has no release yet. The release workflows (npm package with provenance,
container image, GitHub Release with `release-manifest.json`) come before the
first installation, and this guide fills in then.

## Replit

`deploy/replit/` is a template for a Replit deployment that runs a pinned
release:

| File | Does |
| --- | --- |
| `.replit` | A Reserved VM deployment. Its build runs `install-and-verify.sh`; it runs `start.sh`. |
| `install-and-verify.sh` | Installs `@arcforgelabs/flow` at exactly `flow.lock`'s version, runs `npm audit signatures`, then `verify-release.mjs verify`. Any failure fails the build, and Replit keeps the previous deployment. |
| `start.sh` | Starts the installed release with the release's commit as `FLOW_REVISION`. |
| `verify-release.mjs` | Writes `flow.lock` (`pin`) and checks an install against it (`verify`). No dependencies. |
| `flow.lock.example` | The shape of `flow.lock`. |
| `.npmrc` | Lets npm install through Replit's package firewall. |

To use it, create your own **private** deploy repository and copy the
contents of `deploy/replit/` into its root. Your deploy repository holds your
pin and your Replit settings; this public repository never does. Keep every
secret in Replit Secrets.
