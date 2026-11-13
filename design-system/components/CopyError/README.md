# CopyError

The "Copy error" icon button that every error in Flow carries, so a person can paste the full detail to an agent (Gandalf, or any agent with the Flow skill).

- A danger `notice` and a danger `toast` add it by themselves. The alert strip adds it to each alert. Pages add Copy prompt (CopyButton) to a problem with more facts: an invoice, a job's Fix tab, a Reconcile gap, a price row.
- `errorCopy(said, { call })`: `said` is the error's words: they find the Flow call that failed (`noteFailure`, set by `flow()` in `app.js`, when the words show that call's message within 15 seconds), and are not copied, because they can hold a name. The copied text is `errorPrompt` (`server/ui/problem-prompt.js`): the page, that call (method, path, HTTP status, code), the Flow ids in it, the reads to make in Flow, Seazona and Xero, and what waits for the person's yes. `call: false` leaves the failed call out (an alert).
- A danger toast stays while the pointer is on it, so the button can be reached.

Code: `errorCopy` in `server/ui/kit.js`.
