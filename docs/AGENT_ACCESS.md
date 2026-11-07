# Agent access

## Status

Implementation draft for #289 and the bounded read-only slice of #9.
The MCP door stays off by default.
No financial action is in this slice.

## Intended result

An active person connects with Clerk OAuth through stock OpenClaw.
The person can ask why one invoice is held.
Flow returns bounded evidence and links to its existing pages.
The connection must not grant repository, deployment or private support access.

## Delivery gates

The draft must prove the token audience, current person access and organisation boundary.
It must also prove host limits and database read-only enforcement.
No live Clerk or Gateway setup is part of this source draft.
