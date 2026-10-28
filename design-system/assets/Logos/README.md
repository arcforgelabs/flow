# Logos

`flow-mark.svg`: the Flow mark, two waves on a rounded square. Inside the app
it takes the theme's colours: the square is `--t-primary` and the waves are
`--t-on-primary` (`FLOW_MARK` in `server/ui/page.js` owns it). The SVG file
keeps fixed Harbour colours for places with no theme, such as the browser tab
icon. Use the mark at 24px or larger, beside the word "Flow" in the theme's
display face (`--t-display` at `--t-display-weight`, as `.fx-brand` in
`server/ui/flow.css`).
