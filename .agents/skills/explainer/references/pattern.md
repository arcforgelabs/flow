# Explainer pattern

> Copy of `project/explainers.md` in the Arc Forge Design System artifact (https://claude.ai/artifact/8pZbZfefPhvV5kAHUSquEJ), 2026-10-20. When one changes, change the other in the same session. In this repo the kit is `kit/` and the starter is `examples/starter.html`.

An explainer is a page or inline widget that explains a system, a plan or a comparison with visuals first. Use one whenever someone asks to explain something, for more detail, how something works, or to compare things. Marketing pages follow the rest of this book; explainers follow this section.

Reference page: **OpenClaw vs Projects** (https://claude.ai/artifact/ESFw5NeVtSXnC4QJD7CKj6). Start a new page from `examples/starter.html`: it links `kit/tokens.css`, `kit/explainer.css`, `kit/charts.js` and `kit/explainer.js`.

## Pages are wiki pages

- Explainers grow into a wiki. The best ones are refined and published as learning material.
- One subject per page. A loosely related question gets its own page, not another chart on this one.
- Pages link like a wiki: an item that touches another page's subject holds one fact with that page's name and link, and the other page links back.
- Each page stands alone: it defines its own terms, lists its sources and holds no project chatter.

## Choose the diagram (critical)

- Default to a **ConnectionDiagram**: parts as boxes, joined by labelled arrows. Most explainers show how pieces fit together, and only connections show that.
- Each arrow names what moves along it. A box with no arrow is a sign of a missing connection.
- Use another kind only when the subject needs it: a state machine for a lifecycle, capacity bars for amounts against a limit, a timeline for real durations, a table to compare values.
- **Build up from the problem** for a design or a technique: figure 1 shows the problem at its simplest. Each next figure changes one thing, names the change, and shows what it fixes or what still fails. Later figures can combine fixes. Simple figures, many steps. Reference: https://samwho.dev/load-balancing/.
- **Open with a promise, then keep it**: the opening visual shows real data about the exact subject and the question the page answers, so readers know fast if the page is for them. No bait: it should not catch everyone, and the page must deliver what it promises. Reference: https://ngrok.com/blog/prompt-caching.
- **Pretty, with substance**: care in the look is care for the reader. Decoration with no content is not allowed.
- Never use a sequence diagram (lifelines with messages): rated D tier. Show a request path as a ConnectionDiagram.
- FlowLanes (chip lanes) are low tier: they only group things. Use them for short, simple lists.
- Chart Lab rates each kind on the same subject: https://claude.ai/artifact/RESTxZpBbDo9x2mjgWy2f8. Its ratings decide this list. The tiers are in `charts.md`.

## Words

- Diagrams and visual parts first. Add words only where they help.
- One fact per sentence. ASD-STE100 simple English. Australian spelling.
- Text longer than one sentence goes behind progressive disclosure: a DetailPopover or a FactsList. Never show it open on the page.
- No preamble and no "This diagram shows…". No slogan or marketing titles.

## Definitions first (critical)

- Every item that opens shows a **definition first**, under its title: pop-ups, FactsLists, More buttons, diagram boxes, table rows.
- A definition says what the item IS, in 1–2 short sentences with one fact each.
- Style it apart: `text-strong`, 14px, with a 1px `border` rule under it. Numbered facts follow. Facts never repeat the definition.

## Every item is clickable, every fact has an item

- Every named thing in a diagram, flow, table or chart opens a DetailPopover next to it.
- Every fact belongs to an item. If a fact has no item, the diagram is missing that item: add it.
- A FactsList is built from the items. A click on a fact scrolls to its item, pulses it red and opens its pop-up.
- A pop-up never changes the page below. An outside click, Esc or the item again closes it.

## Section heads

- ExplainerHead: a 3px `accent` rule on top, a big red mono number, a plain title, then a 1–2 fact subtitle in `text` (max 66ch). The first fact defines the subject.
- No mono label above the title. The SectionHead label is for marketing pages only.

## Layout and spacing

- `.ex-shell`: 1040px max, centred, a 16px gutter (safe-area aware).
- `.ex-section`: 40px block padding, 20px gap, a 1px `border` rule at the end.
- ConnectionDiagram: an inline SVG; parts 56–70px high, columns with mono caps headers, at least 60px between columns for arrow labels. No label sits on a line.
- FlowLanes: lanes split by 1px `border` rules, mono caps captions, 44px boxes with 8px gaps. Give a busy flow room; never cram it.
- Diagrams and tables sit on `card` with a 1px `border` at `radius-lg`, in their own horizontal scroll at phone width.

## Colour in diagrams

- Plain part: `card` with `border-strong`. Main family: `accent-subtle` with `accent`. Second family: `accent-2-subtle` with `accent-2` (steel). Optional or not live: dashed.
- Red marks only the one thing to see first. Status colours only with a word.

## Tables

- CrispTable: fixed layout, every row 44px, no wrap, ellipsis. Status columns (76px) sit next to the name. The last column holds one sentence and a `More · N` pill.

## Navigation

- TickRail on long pages: fixed in the left gutter, centred top to bottom. Ticks are the same size at rest and grow near the pointer. The current tick is red. Hidden at 900px and below; the content stays centred.

## Inline widgets

- A small idea gets an inline widget in chat instead of a page: neutral boxes, one red element, transparent ground, frame theme classes only, no hex values.
- The same word rules apply.

## Before you publish

- The main diagram shows connections, unless the subject is a list or a set of values.
- Every item opens a pop-up with a definition first.
- Every fact sits in an item; the FactsList leads to each one.
- No open text longer than one sentence.
- Rows keep 44px; the rail picks the right section.
- Light and dark both work; 320px has no sideways scroll.
- A headless browser test shows no page errors and opens every item.
