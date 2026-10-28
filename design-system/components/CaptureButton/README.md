# CaptureButton

The camera button that sends a form photo to Capture.

- `captureButton(ui, { icon, added, done })`: one tap opens the phone's own camera; a desk picks files.
- `icon: true` is the toolbar form (Jobs). The page form says "Capture".
- `send(files)` takes dropped or pasted images too.

Code: `captureButton` in `server/ui/captures.js`.
