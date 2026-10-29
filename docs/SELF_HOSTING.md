# Self-hosting Flow

Run a published Flow release, not a branch of this repository. Each
installation pins one release by version and fingerprint, or follows a
release channel, checks the release before it runs, and upgrades by changing
the pin or publishing again. `docs/RELEASING.md` describes what a release
publishes and how it is made. This is the same model as
[Field](https://github.com/arcforgelabs/field/blob/main/docs/SELF_HOSTING.md).

Every installation needs the same things, whatever runs it:

- **PostgreSQL**: `DATABASE_URL`. The server runs its migrations when it
  starts (`docs/DATA_MODEL.md`), so the first start creates the tables.
  After an upgrade, `flow-server doctor` checks the database against the
  release, and `flow-server migrate` brings it up to the release without
  starting Flow.
- **Sign-in**: `FLOW_AUTH=clerk` and the settings in "Sign-in (Clerk)"
  below. Without it, every person route answers 503.
- **Integrations**: `FLOW_INTEGRATIONS`, the integrations to turn on,
  separated by commas (for example `seazona,xero`). Unset: none. An unknown
  name stops boot. An integration's tables are created at the first start
  with it on, and turning it off never drops them (`docs/INTEGRATIONS.md`).
- **Design system** (optional): `FLOW_THEME`, the theme family every browser
  starts on, for example `tide`. Unset: `harbour`. An unknown name stops
  boot. A person can still choose another on the Appearance page
  (`docs/DESIGN.md`).

Keep every secret in your platform's secret store. Never put one in a file in
a repository, including your own deploy repository.

## Update notice

An installation that runs a release (`GET /health` shows it as
`build.release`) checks whether a newer release is out on its channel. When
one is, the server logs `[flow] update available: <tag> (running <tag>,
channel <channel>)` with links to the release notes and the upgrade steps,
and an owner can read the same from `GET /api/updates`. The server checks at
start and then at most every six hours (`server/update-check.js`), with an
anonymous GET of public release data from GitHub, or npm when GitHub cannot
answer. It sends nothing about the installation. `FLOW_UPDATE_CHECK=off`
turns it off.

The channel is `stable` unless the installation runs a beta, or
`FLOW_DEPLOYED_REF` (Replit) says `beta`; `FLOW_UPDATE_CHANNEL=stable` or
`beta` overrides it. A build that is not a release, such as a checkout of
`main`, asks nothing.

## Pin a release

Each release's `release-manifest.json` (on its GitHub Release) records its
npm integrity, its image digest and its commit.
`deploy/replit/verify-release.mjs` turns one release into a lock file:

```bash
node deploy/replit/verify-release.mjs pin 2026.10.18
```

It downloads that release's manifest, checks the manifest against its
`.sha256`, checks that npm serves the same integrity, and writes `flow.lock`
(see `deploy/replit/flow.lock.example`). Commit `flow.lock` to your deploy
repository. To upgrade, pin a newer version. To roll back, pin the earlier
one.

## Docker

Run the image by the digest in `flow.lock`, after you verify GitHub's
attestation for that digest:

```bash
gh attestation verify oci://ghcr.io/arcforgelabs/flow@sha256:<digest> --repo arcforgelabs/flow
docker run -d -p 19300:19300 -e DATABASE_URL -e FLOW_AUTH=clerk \
  -e CLERK_SECRET_KEY -e CLERK_PUBLISHABLE_KEY \
  ghcr.io/arcforgelabs/flow@sha256:<digest>
```

The image listens on 19300 as an unprivileged user, with its code read only.
`GET /health` names the commit it was built from (`build.revision`) and the
release (`build.release`).

## Node

Install the exact version on Node 24. The package's shrinkwrap pins every
dependency to the tree CI tested. npm 12 ignores `npm-shrinkwrap.json` in a
dependency's tarball (`npm --version` prints the npm version), so install
with npm 11, or check out the release tag and run `npm ci`. Then check its
signatures and provenance:

```bash
mkdir flow && cd flow
npm init -y
npm install --omit=dev --save-exact @arcforgelabs/flow@2026.10.18
npm audit signatures
```

`npm audit signatures` checks the registry signature and the provenance
attestation cryptographically. To check what the provenance claims (the
commit, this repository and its release workflow) against your `flow.lock`,
copy `deploy/replit/verify-release.mjs` from this repository next to your
`flow.lock` and run `node verify-release.mjs verify <install-dir>`. Use your
own copy, not one from the installed package: a package must not vouch for
itself.

Start it with the `flow-server` command, with the environment above:

```bash
DATABASE_URL=postgres://… npx flow-server
```

Run it under a supervisor (systemd, for example) that restarts it.

## Replit

There are two ways to run Flow on Replit:

- **A workspace of this repository that follows a channel.** Import
  `arcforgelabs/flow` into Replit and set the deployment secret
  `FLOW_DEPLOY_REF=stable`. Each publish deploys the current stable release
  from GitHub, after it checks the release manifest and CI. This is how
  Field runs on Replit. `docs/REPLIT.md` is the runbook.
- **A private deploy repository that pins one npm release.**
  `deploy/replit/` is the template:

| File | Does |
| --- | --- |
| `.replit` | A Reserved VM deployment. Its build runs `install-and-verify.sh`; it runs `start.sh`. |
| `install-and-verify.sh` | Installs `@arcforgelabs/flow` at exactly `flow.lock`'s version, runs `npm audit signatures`, then `verify-release.mjs verify`. Any failure fails the build, and Replit keeps the previous deployment. |
| `start.sh` | Starts the installed release with the release's commit as `FLOW_REVISION`. |
| `verify-release.mjs` | Writes `flow.lock` (`pin`) and checks an install against it (`verify`). No dependencies. |
| `flow.lock.example` | The shape of `flow.lock`. |
| `.npmrc` | Lets npm install through Replit's package firewall. |

To use the template:

1. Create your own **private** repository and copy the contents of
   `deploy/replit/` into its root. Your deploy repository holds your pin and
   your Replit settings; this public repository never does.
2. Pin a release: `node verify-release.mjs pin <version>`, and commit
   `flow.lock`.
3. Import the repository into Replit. Add a PostgreSQL database, which sets
   `DATABASE_URL`. Add the sign-in settings below as Secrets.
4. Publish. The build log shows `Verified @arcforgelabs/flow@<version>` and
   the commit, or `REFUSED:` with the reason.

To upgrade, open a pull request in your deploy repository that changes
`flow.lock` (`pin <newer version>`), merge it, and publish again. Before you
upgrade, read the release's notes and the migrations in its manifest.

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
- An owner invites people by email and role, on the People page or with
  `POST /api/people`. Clerk emails the invitation (Clerk's Invitations API,
  from Clerk's own email sender; no mail setting in Flow). Its link opens
  this installation's `/sign-in`, where the invitee makes their Clerk
  account on that address only. Flow links them by their verified email.
- **Email invite again** on the People page (`POST /api/people/:id/invite`)
  sends a new invitation to someone who has not signed in yet. An unused
  Clerk account Flow made for an earlier invitee is removed first, because
  Clerk does not invite an address that has an account.
- If Clerk cannot send the email, Flow makes the invitee's Clerk account (no
  password) instead. The People page then copies a short sign-in message
  for the owner to send; the invitee signs in with Google on that address.
- The invitation email comes from Clerk. Its sender and wording are set in
  the Clerk Dashboard (Customization, Emails, Invitation). The Clerk
  instance must allow sign-up by invitation (Restricted mode allows it).

With `FLOW_PUBLIC_SIGN_UP=on`, anyone with a verified email can sign up and
waits as `pending`, with no access, until an owner approves them.

`FLOW_SIGN_UP_DOMAINS` opens that only to your own domains, for example
`FLOW_SIGN_UP_DOMAINS=example.com`. Someone with a verified email on a listed
domain can sign in without an invitation and waits as `pending` until an owner
approves them. Anyone else still needs an invitation (`403 not_invited`), and
Flow stores nothing about them. Invite people outside those domains by email,
as above.

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
| `FLOW_SIGN_UP_DOMAINS` | configuration | Comma-separated email domains whose people may ask for access without an invitation (they wait for an owner's approval). Everyone else needs an invitation. Unset: none. |
| `FLOW_FIRST_OWNER_EMAIL` | configuration | The first owner's email. Used only while there is no owner. |
| `FLOW_OWNER_GOOGLE_DOMAINS` | configuration | Your Google Workspace domain, for example `example.com`. Comma-separated. Required on Replit's managed Clerk: unset, no owner can manage people. No default. |
| `FLOW_OWNER_MFA_MAX_AGE` | configuration | How long a Clerk second factor counts for owner actions. Default `12h`. |
| `FLOW_PUBLIC_ORIGIN` | configuration | The published app's `https://` origin: its `*.replit.app` address, or a custom domain if it has one. Clerk then accepts only sessions minted for it. In a Replit workspace its development address is accepted too, because the workspace and the published app share secrets. Elsewhere, leave it unset in development. |
| `FLOW_SECRETS_KEY` | secret | Flow's secrets key: 64 hex characters (`openssl rand -hex 32`). It seals the credentials an owner enters in Integrations. Unset: derived from `SESSION_SECRET` when that is at least 32 characters (`docs/INTEGRATIONS.md`, "The secrets key"). |
| `FLOW_BACKGROUND_JOBS` | configuration | `off` stops every job that calls or writes to another system: the Seazona sync, the Xero read, the pipeline, the daily reconcile and the send worker; Xero is then read-only. Unset: off in a Replit workspace (`REPL_ID` set, `REPLIT_DEPLOYMENT` unset), which shares the published app's secrets; on everywhere else. |
| `FLOW_PIPELINE` | configuration | `off` stops the pipeline that links jobs to customers and to accounting invoices (`docs/JOB_INVOICE_LINKS.md`). Unset: on. It writes only to Flow. |
| `FLOW_IMPORT_EARLIER_SCHEMA` | configuration | The schema that holds the earlier codebase's tables. While the database has no organisation, Flow imports from it at start; while it is set, each start also adds the earlier order to invoice links ("Move from the earlier codebase"). Unset: no import. |
| `FLOW_IMPORT_ORGANISATION` | configuration | The lab's name for that import. Required with `FLOW_IMPORT_EARLIER_SCHEMA`. |
| `FLOW_STORAGE` | configuration | `local` (a folder), `s3`, `replit`, or `off`. Unset: `local` on a single machine when the folder can be created, `off` when it cannot (the server image is read-only), `off` on Replit. `local` on a published Replit app stops boot. |
| `FLOW_STORAGE_DIR` | configuration | The local folder. Default `data/storage`. A signing key is created there when `FLOW_SECRETS_KEY` and `FLOW_STORAGE_SIGNING_KEY` are both unset. |
| `FLOW_STORAGE_SIGNING_KEY` | secret | Signs photo links for the local folder and Replit. Unset: derived from `FLOW_SECRETS_KEY` or `SESSION_SECRET`. S3 links are signed by the S3 keys instead. |
| `FLOW_S3_BUCKET`, `FLOW_S3_REGION`, `FLOW_S3_ACCESS_KEY_ID` | configuration | S3-compatible storage. Required with `FLOW_S3_SECRET_ACCESS_KEY` when `FLOW_STORAGE=s3`. |
| `FLOW_S3_SECRET_ACCESS_KEY` | secret | The S3 secret key. Required when `FLOW_STORAGE=s3`. |
| `FLOW_S3_ENDPOINT` | configuration | Optional S3 endpoint, for example a MinIO address. Unset: AWS. |
| `FLOW_S3_FORCE_PATH_STYLE` | configuration | `on` puts the bucket in the path. Unset: virtual-hosted style. |
| `FLOW_READER` | configuration | `on` reads each capture. `off` or unset: the photo is stored and the capture is "reader turned off", for a person to type. |
| `FLOW_READER_REGION` | configuration | `ap-southeast-2` (Sydney) or `ap-southeast-4` (Melbourne). Required when `FLOW_READER=on`. Any other region stops boot. |
| `FLOW_READER_MODEL` | configuration | The `au.` inference profile that reads every capture, for example `au.anthropic.claude-haiku-5-5`. A profile that does not start with `au.` stops boot. |
| `FLOW_READER_MODEL_LARGE` | configuration | The `au.` profile that reads again when case number, practice or work is not sure, for example `au.anthropic.claude-sonnet-5-5`. |
| `FLOW_READER_ACCESS_KEY_ID` | secret | Bedrock key. When it or the secret is missing, the reader stays off. |
| `FLOW_READER_SECRET_ACCESS_KEY` | secret | Bedrock secret. Paired with the access key. |
| `FLOW_READER_SURE_LINE` | configuration | From 0 to 1. Unset: 0.8. A needed field below this is read again by the larger model. |
| `FLOW_READER_INPUT_MICROS_PER_MILLION`, `FLOW_READER_OUTPUT_MICROS_PER_MILLION` | configuration | Optional price override for the first model, in USD micros per million tokens. Unset: the published Australia price for the two Claude 5.5 profiles. An unknown model id records tokens and a null cost until these are set. The `FLOW_READER_LARGE_` pair overrides the second model. |

Boot stops if a setting is malformed or a key is missing. Error messages name
the variable, never its value.

### Verified owner sign-in

Owner actions need one of these:

- **(a) Google Workspace. This is the main path.** The owner's Clerk account
  has a verified Google account with the owner's Flow email, on a domain in
  `FLOW_OWNER_GOOGLE_DOMAINS`, and no password. Google, and the 2-Step
  Verification that the Workspace administrator enforces in Google Admin, is
  then the only way into the account. The second factor lives in Google, not
  in Clerk.
- **(b) A Clerk second factor.** The Clerk session passed a second factor
  within `FLOW_OWNER_MFA_MAX_AGE`. Only an installation with its own Clerk
  application and MFA turned on has this (below). Replit's managed Clerk has
  no MFA.

Otherwise the action gets `403 owner_verification_required`. If Clerk cannot
be asked, it gets `503`, never a pass.

### Replit's managed Clerk

This is the main setup, and the same model as
[Field](https://github.com/arcforgelabs/field/blob/main/docs/REPLIT.md)
("Sign-in (Clerk)"). It works on the app's plain `*.replit.app` address. A
custom domain is optional, and no DNS change is needed: Replit's managed Clerk
serves Clerk through the app's own address (`CLERK_PROXY_URL`).

1. In the Replit workspace, open **Tools > Users & Auth** and add Clerk.
   Replit makes the Clerk instances (development and production) and stores
   `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` as Secrets. If Replit's
   Agent does this, tell it to provision only and not to change Flow's code.
2. In the Auth pane's **Configure** tab, turn on **Google** only. Turn off
   email and password, email codes and email links: each is a way in without
   Google's 2-Step Verification.
3. **Owner step, in Google Admin**: enforce **2-Step Verification** for
   your Workspace domain (Security > Authentication > 2-Step Verification).
   Flow's owner check relies on it.
4. Set `FLOW_AUTH=clerk`, `FLOW_OWNER_GOOGLE_DOMAINS=<your domain>` and
   `FLOW_FIRST_OWNER_EMAIL=<owner's email>` as configuration values, never
   in a repository. On the published app only, set `FLOW_PUBLIC_ORIGIN` to its
   address, for example `https://<app>.replit.app`.
5. Restart. The boot log names the settings it used, never a key.
6. The owner opens `/sign-in` and signs in with Google. The People list
   shows when the owner sign-in is verified. Invite the other people there.

Replit's managed Clerk has no MFA and no Clerk dashboard. Second-factor
protection comes from Google Workspace. People whose email is not on the
Workspace domain can still be `admin` or `staff`, protected by their own
Google account's settings.

### Optional: a custom domain

A custom domain is not needed. To add one, connect it in Replit's deployment
settings, then set `FLOW_PUBLIC_ORIGIN` to the new `https://` origin and
restart.

### Your own Clerk application (Clerk MFA)

An installation that must require MFA in Clerk itself uses its own Clerk
application instead of Replit's managed one. Clerk's production instances
need DNS records on a domain the operator controls, so this route needs a
custom domain. An installation on a plain `*.replit.app` address uses
Replit's managed Clerk and Google Workspace instead.

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

Owners then pass path (b) on every sign-in, and `FLOW_OWNER_GOOGLE_DOMAINS`
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
- how many proxies Replit puts in front of a published app (Flow trusts one);
- sign-in through `CLERK_PROXY_URL` on a published `*.replit.app` address.

## Move from the earlier codebase

An installation that ran the earlier Flow codebase moves its records into a
new, empty Flow database with `server/import-earlier-flow.js`
(`server/import/earlier-flow.js` says what moves and why).

| Moves | Source in the earlier database |
| --- | --- |
| Customers and suppliers | Its copy of the accounting system's contacts. Archived contacts stay behind. |
| The price list | Its copy of the accounting system's sold items, with their price and tax type. |
| Invoice prefix and next number | The highest sales invoice number, so Flow never issues a number the accounting system already holds. |

Patient and case details, sync state and logins never move. Each integration
reads its own records again from its source when it is turned on, and people
sign in with Clerk ("Sign-in (Clerk)").

1. Make a copy of the earlier database and use the copy as the source.
2. Run a dry run. It reads the source in a read-only transaction and prints
   counts and the reasons rows stay behind, never names or amounts:
   `EARLIER_FLOW_DATABASE_URL=… node server/import-earlier-flow.js --dry-run`.
3. Run it against the new Flow database:
   `EARLIER_FLOW_DATABASE_URL=… DATABASE_URL=… node server/import-earlier-flow.js --organisation "<lab name>"`.
   It runs Flow's migrations, refuses a database that already has an
   organisation, writes in one transaction and checks the row counts.

Keep both connection strings out of chat and shell history.

### When the app has no shell (a published Replit app)

The earlier tables and Flow's own tables can share one database. Flow then
imports at its own start:

1. Back up the database.
2. Move every table and view of the earlier codebase out of `public` into its
   own schema, in one transaction, without dropping anything. Also rename a
   `drizzle` schema that the earlier codebase left, or Flow reads its
   migration record as its own and skips its migrations:

   ```sql
   BEGIN;
   CREATE SCHEMA earlier;
   DO $$
   DECLARE t record;
   BEGIN
     FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
       EXECUTE format('ALTER TABLE public.%I SET SCHEMA earlier', t.tablename);
     END LOOP;
     FOR t IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
       EXECUTE format('ALTER VIEW public.%I SET SCHEMA earlier', t.viewname);
     END LOOP;
     IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
       ALTER SCHEMA drizzle RENAME TO earlier_drizzle;
     END IF;
   END $$;
   COMMIT;
   ```

   Sequences move with their tables. To undo before Flow starts, move the
   tables back the same way and rename `earlier_drizzle` to `drizzle`.
3. Set `FLOW_IMPORT_EARLIER_SCHEMA=earlier` and
   `FLOW_IMPORT_ORGANISATION=<lab name>`, then start (publish) Flow.
4. While the database has no organisation, the start reads that schema in a
   read-only transaction and writes the records. A failed import stops the
   start, so Flow never opens with half its records. The log shows the counts
   (`[import]`). Once an organisation exists, the start imports no more
   records.
5. While both settings stay set, each start also carries over the earlier
   app's order to invoice links (`seazona_order_xero_match_overrides`) into
   `prior_links`. It adds only links Flow does not hold, copies ids only (no
   notes, no names), and logs `[import] links`. A failure here is logged and
   the start goes on. Unset both settings when the links are in.

### Capture settings

An owner opens **Capture → Settings** to turn the reader on or off. Changes
require a verified owner sign-in and are recorded in `integration_setting_events`.
The installation-wide switch lives in `integration_settings` as `capture.config.CAPTURE_READER`.
With no saved choice, existing host-enabled reading continues. Off stops new
and queued reads; a call already running can finish. Manual entry still works.
Host storage and `FLOW_READER*` configuration remain necessary; Settings reports
whether the running process has storage and a reader, without exposing keys.
It does not prove that an external service is reachable.

**This month** sums `captures.read->>'costMicros'` for the selected organisation's
captures created in the current UTC month, in USD. Unpriced reads are reported
separately. Undecided captures expire after seven days, including their cost:
this accepted limitation means the displayed total can decrease and is not a
billing ledger. Applied/discarded captures retain their recorded costs.

Work system integrations show **Two-way sync** off and unavailable. No supported
job-update API is wired; Seazona has no order-update call. Capture Apply still
writes only Flow custom fields and their field events.

On a desktop, **Use phone** encodes only the installation origin plus `/captures`.
The QR is generated locally with pinned, MIT-licensed `qrcode-generator`; no
external QR service sees the address. No session, capture id or signed key is
included. The phone needs its own sign-in. Desktop review uses the shared sidecar
beside the capture list; smaller screens retain the result dialog.
