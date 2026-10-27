# Security Policy

Flow handles a lab's invoices, supplier bills, bank details and integration
credentials, and it can see case references from a dental lab. Treat every
report about those with care.

## Report a Security Issue

Report privately through GitHub's "Report a vulnerability" (Security tab of
this repository). Never open a public issue for a security problem, and never
paste a credential, in full or in part.

### What We Need

- The affected version or commit, and the route, screen or file.
- Steps to reproduce, with synthetic data only.
- What an attacker gains.

## Trust Model

- **One installation per lab.** Each installation runs with its own database,
  configuration and secrets. Installations never share data or credentials.
- **People.** People sign in with Clerk. Flow's PostgreSQL holds each person's
  role (`owner`, `admin` or `staff`) and access. A Clerk account with no Flow
  role gets no access, and an installation is invitation only by default.
  Owner-only actions need a verified owner sign-in (`docs/SELF_HOSTING.md`,
  "Sign-in (Clerk)").
- **Machine access.** The Flow API uses signed connector keys, never Clerk
  sessions. Keys are read only from request headers and are checked against
  the holder's current access on every use.
- **Integrations.** Seazona, Xero and every later adapter reach the core only
  through the integration port. Their credentials are stored per
  organisation, encrypted, and are write-only in Settings.
- **Records and files.** Every record is in the installation's PostgreSQL.
  Files reach the core only through the object storage port; PostgreSQL
  holds each file's key, owner, size and hash. When Flow serves a file it
  checks the hash first. Download links are signed. An S3 link is a presigned
  URL the store itself honours.
- **Issued documents are records.** An invoice a customer has been sent is
  never changed in place; a change produces a new version.

## Rules Held Hard

- Never commit customer data, patient data, credentials, raw private messages
  or runtime state. Tests and demos use synthetic fixtures. A photo, export or
  screenshot from a real lab is customer data.
- Never commit a real organisation identifier (a Xero tenant id, a Seazona
  tenant hostname, an ABN or a bank account). They belong in the
  installation's configuration.
- Secrets live in the installation's secret store (for example Replit
  Secrets), never in the repository, a log, an issue or a pull request. Name
  the variable, never its value.
- No account has a built-in or fallback password, in any environment.
- Sign-in, API and integration routes are rate limited per client
  (`server/rate-limit.js`): the sign-in page and its config 30 requests a
  minute, `/api` 120, and the Clerk proxy 300. A client over the limit gets
  `429` with `Retry-After`.
- Session cookies are `Secure`, `HttpOnly` and `SameSite`.
- Flow stores no clinical notes or scans, and keeps a patient reference only
  where an invoice must print one. A form photo is kept only until someone
  decides the capture, or for 7 days when nobody does, and then the bytes are
  deleted. Logs and error reports get the capture id and an error code, never
  the photo or what was read or typed.
- Object keys and file names carry a case number at most, never a patient
  name or other patient data.
- CI runs gitleaks on every push and pull request
  (`.github/workflows/secret-scan.yml`).

## Out of Scope

- Vulnerabilities in a third-party service Flow connects to (Clerk, Seazona,
  Xero). Report those to the vendor.
- Problems that need an attacker who already holds an owner sign-in or the
  installation's secrets.
