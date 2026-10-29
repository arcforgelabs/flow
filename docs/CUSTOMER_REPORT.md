# Customer report (What's new)

Each week Flow makes a report for its customers as a pair of files:

| File | What it is |
| --- | --- |
| `email.html` | The email summary. Tables and inline styles only, 600px wide, no script. The timeline is an image. Merge fields stay in for the sender: `{{first_name}}`, `{{account}}`, `{{preferences_url}}`, `{{unsubscribe_url}}`, `{{sender_address}}`. |
| `site.html` | The full web page: highlights with walkthrough videos, the week ahead, the ongoing checks, the timeline, security, support and uptime. Each link in the email opens this page at its section or its card. |

Issue: #388.

## Where the words come from

Only public GitHub records. The public workflow reads no customer data, Sentry or support
tickets, so no person or AI has to look at private data to write a report.

| Report part | Source |
| --- | --- |
| Period | Last Monday to Sunday, plus this week to date, in `Australia/Sydney` |
| Each update | A line under `### Highlights` in a published release |
| Its why line | The first sentence of the pull request's **User Impact** section |
| Major, Support, left out | Pull request labels `report: major`, `report: support`, `report: hide` |
| Security | Merged pull requests labelled `impact:security` |
| In progress | Open issues labelled `roadmap`; the stage comes from the open pull request that names the issue (none = Plan 0%, draft = Build 25%, ready = Review 50%, approved = Test 75%) |
| Walkthrough video | `docs/evidence/<set>/index.json` entries that list the pull request in `prs` |
| Uptime | "No data" until an uptime source exists. The report never guesses a number. |

So the report reads well when the pull request reads well: write the first
sentence of User Impact for a customer, and add the labels.

## The template

`scripts/report/report.yml` holds what a person writes once: the product name,
the labels, the stats, the checks in the ring, the icon for each keyword
(Lucide names) and the uptime text. `scripts/report/site.html` is the page
layout. Change these by pull request.

## Run it

The **Customer Report** workflow (`.github/workflows/customer-report.yml`)
runs when a release is published, each Monday morning, and by hand. It uploads
`report.json` and `out/` as the `customer-report` artifact.

```sh
GITHUB_REPOSITORY=arcforgelabs/flow GITHUB_TOKEN=... node scripts/report/collect.mjs --out report.json
node scripts/report/render.mjs --report report.json --out out --site-url https://<where the page lives>
```

`render.mjs --merge '{"first_name":"Sam"}'` fills merge fields in
`email-preview.html`, a copy for a browser preview.

## Not here yet

- Hosting the page behind the Arc Forge sign-in: arcforgelabs/console#24.
- Sending the email with consent and unsubscribe: arcforgelabs/platform#439.

## Private editions and first publication

The public workflow produces a generic product update only. Keep managed-account
configuration, subscriber details, optional Sentry configuration and generated
customer editions outside this public repository and its Actions artifacts.
Use `--config /private/report.yml` and `--out /private/report.json` when collecting
an account edition, then render to a private directory. Sentry is optional; a
private runner may provide its read-only configuration. Only counts and first-seen
dates enter the report, never error text or project names.

Before publishing the first edition, the maintainer must choose the private host
and allowed audience, configure its access protection, and supply the final page
URL to `--site-url`. No host or access policy is selected by this generator.
Keep the email as a draft; the maintainer fills the subscriber merge fields and
sends it. A private timeline image may require attachment/CID handling by the
sender because mail clients cannot sign in to the protected website.

Local synthetic collect/render proof does not prove a scheduled GitHub run,
host deployment, sign-in enforcement or email delivery. Those remain separate
publication checks.
