# Sentry

Issue #82. The Sentry adapter sends an installation's errors and problem reports to that
installation's own Sentry project. Flow ships no DSN. Each installation
enters its own, so its reports never reach the Flow maintainers or another
installation.

```mermaid
flowchart LR
  server[Flow server] -- "each logged error" --> log[Monitored log]
  log -- captureError --> sdk[@sentry/node]
  browser[Browser] -- "GET /api/monitoring" --> config[DSN, environment,<br/>release, Report a problem]
  browser -- "errors and<br/>Report a problem" --> project[(The installation's<br/>Sentry project)]
  sdk --> project
  project -- "Sentry's own integrations" --> tracker[Issue tracker, alerts]
```

## Turn it on

1. In the organisation's own Sentry account, create a project (platform
   Express).
2. Copy its DSN from the project's Settings, Client Keys (DSN).
3. In Flow, open **Integrations, Sentry**, paste the DSN and turn Sentry on.
   A host can instead set `SENTRY_DSN` (on Replit, as a Secret) and turn it on
   in Flow or with `FLOW_INTEGRATIONS=sentry`. The host's setting wins.

| Setting | What it does | Default |
| --- | --- | --- |
| `SENTRY_DSN` | The project's DSN. Browsers see it, so it is not a secret. | none: Sentry cannot start |
| `SENTRY_ENVIRONMENT` | The environment Sentry shows for this installation. | `production` |
| `SENTRY_FEEDBACK` | `on`: "Report a problem" shows in the account menu for everyone signed in. | `on` |

A change in Flow applies at once, with no restart. The adapter has no tables.

## What goes to Sentry

- **Server errors.** Every line Flow logs as an error, from the HTTP app, the
  integrations and the pipeline (`server/core/monitoring.js`). A line's
  leading `[tag]` becomes the `source` tag. A server fault no route answered
  is logged as `[http]` and answered with no detail.
- **Browser errors.** Uncaught errors in the signed-in app.
- **Problem reports.** "Report a problem" in the account menu (the name at
  the foot of the sidebar) opens Sentry's feedback form, with an optional screenshot. It shows only while
  Sentry is on and `SENTRY_FEEDBACK` is on.
- **Who.** Each browser event carries the person's Flow id and email, so the
  lab can follow up. `sendDefaultPii` is off: no cookies, request bodies or IP
  addresses.
- **Release.** `flow@<release>` from the Flow release tag, else the commit.

With Sentry off, Flow loads no Sentry code in the browser, sends nothing, and
hides the button.

The browser SDK loads from Sentry's CDN, pinned to one version and checked
against its integrity hash (`SENTRY_BROWSER` in
`server/integrations/sentry/index.js`). To update it, change the version and
the hash together.

## Reports into an issue tracker

Sentry's own integrations (Settings, Integrations in Sentry) link an issue or
a report to a task in an issue tracker. Flow does not call the tracker.

## Who else can see the reports

Only the people in the installation's Sentry organisation. To give a support
person access, the organisation invites them in Sentry.
