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

## Sign-in (Clerk)

People sign in to Flow with [Clerk](https://clerk.com). Clerk holds
passwords, second factors and sessions. Flow checks the Clerk session on
every request and keeps each person's role in its own `people` table
(`docs/DATA_MODEL.md`). A Clerk account with no Flow person gets no access.

Sign-in is off until `FLOW_AUTH=clerk` is set. While it is off, every person
route answers `503 sign_in_not_configured`; Flow never runs open.

### Roles

| Role | May |
| --- | --- |
| `owner` | Everything, and manage people: invite, change roles, turn access off, remove |
| `admin` | Manage settings and integrations (as those modules arrive) |
| `staff` | Everyday work: invoices, bills, payments |

Only an owner manages people, and only with a verified owner sign-in (below).
Flow always keeps one active owner, and nobody changes or removes themself.

### Invitation only

`FLOW_PUBLIC_SIGN_UP` is off by default. With it off:

- Flow's sign-in page (`/sign-in`) has no sign-up link, and an OAuth sign-in
  for an unknown email is not turned into a new Clerk account.
- Someone with a Clerk account made elsewhere still gets no access, and Flow
  stores nothing about them (`403 not_invited`).
- An owner invites people by email and role, on the sign-in page or with
  `POST /api/people`. Flow makes the invitee's Clerk account (no password)
  through Clerk's Backend API. The invitee signs in with Google on that
  address, and Flow links them by their verified email.

With `FLOW_PUBLIC_SIGN_UP=on`, anyone with a verified email can sign up and
waits as `pending`, with no access, until an owner approves them.

The first owner comes from `FLOW_FIRST_OWNER_EMAIL`. At boot, while the
installation has no owner, Flow invites that address as owner. Once an owner
exists, the setting does nothing.

### Settings

Keep these in the installation's secret store, never in a repository.

| Variable | Kind | What it does |
| --- | --- | --- |
| `FLOW_AUTH` | configuration | `clerk` turns sign-in on. Unset: off. Any other value stops boot. |
| `CLERK_SECRET_KEY` | secret | Set by the Clerk integration (`sk_test_…` or `sk_live_…`). Server only; never logged. |
| `CLERK_PUBLISHABLE_KEY` | secret | Set by the Clerk integration (`pk_test_…` or `pk_live_…`; `VITE_CLERK_PUBLISHABLE_KEY` also works). Flow gives it to the browser at runtime from `GET /api/auth/config`. |
| `CLERK_PROXY_URL` | set by Replit | On a published Replit app. Flow serves Clerk's Frontend API on that path. |
| `FLOW_PUBLIC_SIGN_UP` | configuration | `on` lets strangers ask for access. Unset or `off`: invitation only. |
| `FLOW_FIRST_OWNER_EMAIL` | configuration | The first owner's email. Used only while there is no owner. |
| `FLOW_OWNER_GOOGLE_DOMAINS` | configuration | Your Google Workspace domain, for example `example.com`. Comma-separated. No default: unset turns the Google Workspace owner path off. |
| `FLOW_OWNER_MFA_MAX_AGE` | configuration | How long a Clerk second factor counts for owner actions. Default `12h`. |
| `FLOW_PUBLIC_ORIGIN` | configuration | The published `https://` origin. Clerk then accepts only sessions minted for it. Leave unset in a development workspace. |

Boot stops if a setting is malformed or a key is missing. Error messages name
the variable, never its value.

### Verified owner sign-in

Owner actions need one of these:

- **(a) A second factor.** The Clerk session passed a second factor within
  `FLOW_OWNER_MFA_MAX_AGE`. This needs a Clerk application with MFA, which
  Replit's managed Clerk does not have.
- **(b) Google Workspace.** The owner's Clerk account has a verified Google
  account with the owner's Flow email, on a domain in
  `FLOW_OWNER_GOOGLE_DOMAINS`, and no password. Google, and the 2-Step
  Verification its Workspace enforces, is then the only way into the account.

Otherwise the action gets `403 owner_verification_required`. If Clerk cannot
be asked, it gets `503`, never a pass.

### Replit's managed Clerk

This is the same model as
[Field](https://github.com/arcforgelabs/field/blob/main/docs/REPLIT.md)
("Sign-in (Clerk)").

1. In the Replit workspace, open **Tools > Users & Auth** and add Clerk.
   Replit makes the Clerk instances (development and production) and stores
   `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` as Secrets. If Replit's
   Agent does this, tell it to provision only and not to change Flow's code.
2. In the Auth pane's **Configure** tab, turn on **Google** only. Turn off
   email and password, email codes and email links: each is a way in without
   Google's 2-Step Verification.
3. In Google Admin, enforce **2-Step Verification** for your Workspace
   domain.
4. Set `FLOW_AUTH=clerk`, `FLOW_OWNER_GOOGLE_DOMAINS=<your domain>` and
   `FLOW_FIRST_OWNER_EMAIL=<owner's email>` as configuration values. Set
   `FLOW_PUBLIC_ORIGIN` on the published app only.
5. Restart. The boot log names the settings it used, never a key.
6. The owner opens `/sign-in` and signs in with Google. The People list
   shows when the owner sign-in is verified. Invite the other people there.

Replit's managed Clerk has no MFA and no Clerk dashboard. Second-factor
protection comes from Google Workspace. People whose email is not on the
Workspace domain can still be `admin` or `staff`, protected by their own
Google account's settings.

### Your own Clerk application (Clerk MFA)

An installation that must require MFA in Clerk itself uses its own Clerk
application instead of Replit's managed one:

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com),
   owned by the organisation that runs the installation.
2. **User & authentication**: turn on the sign-in methods you want, and turn
   on **Multi-factor authentication** with **Require MFA** for every user.
3. **Restrictions**: set the sign-up mode to **Restricted**, so Clerk itself
   refuses sign-ups that are not invited. Keep `FLOW_PUBLIC_SIGN_UP` off.
4. Production instance: add your domain and its DNS records, as the
   dashboard lists them.
5. Put the instance's keys in `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`
   (not through Replit's Users & Auth pane), and set `FLOW_AUTH=clerk`.

Owners then pass path (a) on every sign-in, and `FLOW_OWNER_GOOGLE_DOMAINS`
can stay unset.

### Machine access

The Flow API (`/api/flow/v1`) is for scripts, the `flow` CLI and outside
agents. It uses signed connector keys, never Clerk sessions
([issue #9](https://github.com/arcforgelabs/flow/issues/9)). Until connector
keys exist, it refuses every request.

### Not verified yet

Built and tested with Clerk faked (no keys, no network). Not yet tried
against a real Clerk instance:

- that Google sign-in joins the Clerk account Flow makes for an invitee;
- the Clerk user shape Replit's managed instance returns for a Google-only
  user;
- the sign-in widget with `transferable: false` on Replit's managed instance;
- how many proxies Replit puts in front of a published app (Flow trusts one).
