# HoldButton

A button that waits between presses, to keep inside Xero's and Seazona's limits.

- `holdButton(button, ms)` turns it off and shows the time left ("Sync · 5s").
- Use it on every button that calls a connected system; the server says the wait.

Code: `holdButton` in `server/ui/kit.js`.
