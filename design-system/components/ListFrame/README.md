# ListFrame

The window a list or board sits in, under ListHead (as HubSpot's lists).

- `listFrame(main, content)` gives `{ element, body, tools, count }`. Append `element` after the ListHead nodes.
- On a desktop the page is the window's height. The frame fills it to the bottom and scrolls inside itself, both ways. Nothing runs off the page.
- A table's head stays at the top of the frame while its rows scroll.
- The foot bar: `count('30 jobs')` at the left, `tools` (Export, later) at the right.
- A table or panel inside the frame drops its own border.
- `edgeFade(scroller, { target, edges })`: rows and cards fade under an edge they scroll past. It shows only when there is more that way, and not where a scrollbar or the sticky table head already marks the edge. The board uses it for its sides and for each lane's foot.
- On a phone the frame grows with its rows and the page scrolls.

Code: `listFrame`, `edgeFade` in `server/ui/kit.js`; `.fx-frame` in `server/ui/flow.css`.
