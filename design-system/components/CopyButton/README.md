# CopyButton

An icon-only button that copies text, for example "Copy prompt" on an invoice problem.

- `copyButton({ label, text, copied })`: `label` names it and shows on hover; `text()` builds the text at the click, so it holds the page's current facts.
- The copy runs inside the click. If the browser refuses, a dialog shows the text selected, to copy by hand.
- "Copy prompt" text comes from `problemPrompt` (`server/ui/problem-prompt.js`): codes, numbers, Flow ids and links only.

Code: `copyButton` in `server/ui/kit.js`.
