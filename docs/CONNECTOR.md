# Flow connector

One OpenClaw Gateway uses one signed connector key. The key is bound to one Flow person. Gateway access includes this integration. Flow does not add a second permission check inside the Gateway.

The server stores the public key only.

Set these three values together:

- `FLOW_CONNECTOR_KEY_ID`
- `FLOW_CONNECTOR_PUBLIC_KEY` (SPKI DER, base64)
- `FLOW_CONNECTOR_PERSON_ID`

Each request sets `X-Flow-Key-Id`, `X-Flow-Timestamp` and `X-Flow-Signature`. The signature is Ed25519 over the timestamp, method, path and the SHA-256 of the raw body.

`GET /api/flow/v1` returns the Flow version and the operation list. The plugin refuses a mismatch.

The connector can list jobs, set a job field, list invoices, read one invoice and edit a draft. Issue, revise, void, send and Xero push stay in the signed-in Flow app.

A missing or bad signature gets `401` and `connector_signature_required`.
