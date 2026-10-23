---
title: "Flow docs"
summary: "Job management, invoicing, bill approval and a financial dashboard for labs that make work to order."
---

# Flow docs

Flow keeps a lab's jobs, prices and invoices in its own PostgreSQL database.
Integrations such as Seazona and Xero connect to that data. Flow sends to
them from its own copy.

## Start here

- [Self-host Flow](SELF_HOSTING.md) on your own server or container host.
- [Run Flow on Replit](REPLIT.md).
- [Send invoices](INVOICE_SENDING.md): Pending, Ready, Draft, Approved, Sent and Send all ready.
- [Contacts](CONTACTS.md): Flow's own customers and suppliers, and creating a missing Xero client.

## How Flow works

- [Data model](DATA_MODEL.md) and the [data spine](DATA_SPINE.md) that every integration shares.
- [Integrations](INTEGRATIONS.md): [Xero](XERO.md), [Seazona](SEAZONA.md) and [Sentry](SENTRY.md).
- [Invoice rules](INVOICE_RULES.md) and [automations](AUTOMATIONS.md).

## Releases

[Release notes](releases/index.md) list what changed in each version.

The source of these pages is the `docs/` folder of
[arcforgelabs/flow](https://github.com/arcforgelabs/flow).
