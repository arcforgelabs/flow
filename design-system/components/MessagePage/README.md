# MessagePage

The shared HTML card after an integration approval (OAuth callback). Static card.

- `messagePage({ title, text, tone, integration, organisation, mode, autoReturnSeconds })` in `server/ui/page.js`.
- Shows Flow's mark beside the maker's logo, a status line (organisation · mode), a tick or cross, and "Back to Flow".
- Success may return to Flow after a few seconds with a polite countdown; failure never auto-returns.
- Every integration with an approval step uses this page, not its own copy.

Code: `messagePage` in `server/ui/page.js`.
