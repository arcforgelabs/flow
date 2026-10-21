# Chart catalogue

Chart Lab drew 42 kinds of chart on the same subject. Samuel rated each kind: great, good, meh or poor. Use this list to pick a chart. Pick from great and good. Use meh only with the fix in its note. Do not use poor.

Source: Chart Lab, https://claude.ai/artifact/RESTxZpBbDo9x2mjgWy2f8 (ratings of 2026-10-19). The page source holds a hand-drawn SVG for every kind: copy from it when `charts.js` has no renderer.

`charts.js` column: the renderer name in `kit/charts.js`, or `—` (draw it by hand).

## Great

| Kind | Family | charts.js | Note |
| --- | --- | --- | --- |
| Container diagram | Boxes and arrows | `container` | Zones that hold parts. Better than a layer stack. |
| Live anatomy | Boxes and arrows | — | Lines of code next to their effect on a chart. Highest potential for teaching. Make the controls strong. |
| Sketch style | Boxes and arrows | — | A rough-pen filter over a normal diagram. A style, not a kind: use it on a diagram that is a quick idea. |
| Heatmap | Amounts | `heatmap` | A value for each row and column pair. |
| Sankey | Amounts | `sankey` | Flows as bands; band width is the amount. |
| Parallel sets | Amounts | — | One group split by several categories in turn. |
| GPU graph | Networks | — | Thousands of linked parts (cosmos.gl). For real, large graphs only. |

## Good

| Kind | Family | charts.js | Note |
| --- | --- | --- | --- |
| Connection diagram | Boxes and arrows | `connection` | The default diagram. Parts as boxes, joined by labelled arrows. |
| State machine | Boxes and arrows | — | States of one thing and the events that move it. For lifecycles. |
| Anatomy callout | Boxes and arrows | — | Labels on the parts of one thing. Tie code lines to their effect. |
| Expand and collapse | Boxes and arrows | — | Groups open on tap. Readers keep open what they need. |
| Capacity bars | Amounts | `capacity` | One limit split into named parts, one bar per step. |
| Treemap | Amounts | — | How much space each part takes. Add details on tap. |
| Sunburst | Amounts | — | Related parts on the inner ring, their details on the outer ring. |
| Timeline | Time and order | — | Events and waits on a real time scale. |
| Snake flow | Time and order | — | A long line of steps that wraps. |
| Tree | Hierarchy | — | Parent and child parts. |
| Fishbone, version 2 | Hierarchy | — | Causes of one failure; each failure path is obvious. |
| Arc diagram, version 2 | Networks | — | Parts on one line, links as arcs, with focus on hover. |
| Grouped graph | Networks | — | Parts in hulls. Good in sketch style. |
| Grouped graph, version 2 | Networks | — | Layers that turn on and off. |
| Concentric | Networks | — | Rings of parts. Use a high-contrast theme for busy lines. |
| Particle flow graph | Networks | — | Moving dots show speed, volume and where data backs up. |
| 3D graph | Networks | — | Needs labels, a legend and pause on hover. |
| 3D graph, WebGL | Networks | — | Calm motion: drag turns the view; hover waits. |

## Meh: use only with the fix

| Kind | Fix |
| --- | --- |
| Arc diagram | Use version 2. |
| Area chart with tooltip | Use only with data that is a real series over time. |
| Bump chart | Ranks over time. No note yet. |
| Edge bundling | Attractive but slow to read. Add hover focus or expand and collapse. |
| Chord diagram | Attractive but slow to read. Same fix as edge bundling. |
| Fishbone | Use version 2. |
| Hive plot | No note yet. |
| Keyed container diagram | Prefer the container diagram with the diagram colour key in a legend. |
| Ladder | No note yet. |
| Mind map | Other kinds do this job better. |
| Radial tree | Add expand and collapse. |
| Sequence diagram | Do not use. A chart that needs a tutorial is a bad chart. Show a request path as a connection diagram. |
| Step-through simulation | A great feature. Free it from fixed colours: let it follow the theme. |
| Every token | No note yet. |

## Poor: do not use

| Kind | Why |
| --- | --- |
| Chip lanes (FlowLanes) | Shows no connections. Only for very short, simple lists. |
| Layer stack | You have to squint. Use a container diagram. |
| Scroll story, WebGL | Rated poor. |

## Lessons from the ratings

- A theme can make or break a chart. High contrast made the concentric layout clear.
- Attractive is not enough. If the meaning is slow to read, add focus on hover, hidden detail or expand and collapse.
- The data must fit the chart. A good chart with the wrong data reads as meh.
- Progressive disclosure wins: expand and collapse, pop-ups and Facts lists.
