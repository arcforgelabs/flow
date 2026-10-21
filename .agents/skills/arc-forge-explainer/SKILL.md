---
name: arc-forge-explainer
description: Explain with visuals in the Arc Forge look. Use when asked to explain, give more detail, show how something works, compare, map or plan, and before any diagram or HTML explainer page.
---

An explainer is a page that explains a system, a plan or a comparison with visuals first. Samuel reads explainers instead of long text.

Use this skill when Samuel asks to explain something, for more detail, how something works, to compare, to map, or for a plan. Samuel's own words win over this skill. The design system (references/explainers.md) wins for brand values.

## Files in this skill
- references/explainers.md: the design rules and the component list (ExplainerHead, DetailPopover, FactsList, CrispTable, FlowLanes, TickRail, ConnectionDiagram).
- assets/explainer-starter.html: the starting page. It holds the tokens, the .ex- styles and the runtime script.

## Choose the size
- One small idea with five to nine parts: a short reply with one simple diagram.
- More than that, or Samuel asks for detail: a full explainer page.
- Text longer than about fifteen lines is never the answer. Make the page.

## Rules
1. Visuals first. Add words only where they help.
2. One fact per sentence. ASD-STE100 simple English. Australian spelling. No preamble, no "This diagram shows…", no slogans.
3. Definition first, everywhere. Every item that opens shows what the item IS (1–2 short sentences) before its facts. Facts never repeat the definition.
4. Every item opens. Every box, chip, label, row and chart part opens a pop-up next to it. A pop-up never changes the page below.
5. Every fact has an item. If a fact has no item, the diagram is missing that item: add it.
6. Progressive disclosure. Text longer than one sentence sits behind a pop-up or a Facts list.
7. One red. Neutral grey surfaces, hairlines, red only for the one thing to see first. Steel only for a second neutral family. Status colours only with a word. No gradients, glows, emoji or coloured left-border cards.

## How to build a page
1. Copy assets/explainer-starter.html. Keep its token block, styles and runtime script. Replace the sample sections. Never change the token colours: section numbers and the 3px head rule stay red (accent).
2. Title block: `.ex-title` with a plain h1, then 1–2 facts, then a mono meta line (source · date).
3. One `.ex-section` per subject, each opened by an ExplainerHead: red top rule, red two-digit number, a plain title, and a subtitle whose first sentence defines the subject.
4. Diagrams: default to a ConnectionDiagram (inline SVG in `.ex-figure`, boxes joined by labelled arrows, an `.ex-hot` rect over every part). Use FlowLanes only for short grouped lists. Never use a sequence diagram.
5. Tables: CrispTable. 44px rows, status dots next to the name, one sentence plus a `More · N` button in the last column.
6. Data: put every item in `window.EX` as `{"t": title, "l": layer, "d": definition, "x": [facts]}` and give its element `data-ex="<key>"`. The layer is where the item sits, in caps.
7. Facts list: end a section with `<details class="ex-facts" data-def="…">`. The runtime fills it from the items.
8. Rail: on a page with four or more sections, keep `<nav class="ex-rail">`. The runtime builds the ticks.
9. Sources: a last section lists each source with its date.

## Check before you hand it over
- The page has no script errors.
- Every `[data-ex]` element has an entry in `window.EX` with a definition.
- No sideways scroll at 390px wide. Light and dark both read well.
- No open text longer than one sentence. Red on only one or two things.

## Pages are wiki pages
- One subject per page. A related question gets its own page.
- When an item touches another page's subject, add one fact with that page's name and link.
- Each page stands alone: it defines its own terms, lists its sources and holds no project chatter.
