---
paths:
  - "apps/web/client/**"
---

# The dashboard

`src/insights.ts` turns tracked numbers into the decision an ASO cycle needs,
and states its thresholds in one place so they can be argued with: popularity ≥5
is the floor for measurable volume and ≥30 is a head term; below roughly rank 10
nothing earns taps; a difficulty ≥80 means the incumbents will not be moved by
metadata alone; a rank that moved in the last 48h is unproven because Apple
reshuffles.

Those rules produce four lanes: **winning** (defend), **within reach** (aim the
next release here), **blocked** (needs more than metadata), **vanity** (ranked
where nobody searches; reclaim the slot). Two habits matter more than the
numbers:

- **Brand terms are counted separately.** You should already be #1 on your own
  name, and brand demand is the ceiling on what generic ASO can add. Mixing them
  into one average flatters the picture, so the headline is
  generic-keywords-in-top-10.
- **Average rank is a vanity metric**, dragged around by dead keywords. The
  distribution and the lane counts are the real health read.

Metadata changes are drawn on the rank chart as markers, because a rank move is
only interpretable against the release that might have caused it. The markers
are **numbered pins keyed to a caption**, not repetitions of the word
"metadata": three releases in a fortnight are otherwise indistinguishable from
each other, and a marker you cannot attribute anchors nothing. The report reuses
`queries/metadata.ts` for that diff rather than keeping its own dates-only
query.

The chart is reachable without a mouse. The crosshair is the only way to read an
exact value off it, so arrow keys walk the same index (Home/End jump, Escape
clears) and the readout is mirrored into a polite live region in the same words
the tooltip uses. The graphic carries `aria-describedby` to a `<figcaption>`
that says what a gap means, and the dense table below it is the numeric
alternative the caption points at.

**The chart's coordinate space is CSS pixels, measured, never a fixed design
unit.** A `960 x 360` viewBox stretched to `width: 100%` scales its own text
with the card: every SVG label renders at `14 * (width / 960)`, which is 17px on
a wide screen and under 10px in a narrow column, and never the size the type
token asks for. The `.chart` box is measured (synchronously on attach, then by a
`ResizeObserver`) and the viewBox width follows it, so one unit is one pixel at
every width and the chart keeps a constant height instead of ballooning.
`FALLBACK_W` covers the case where the box reports nothing.

**The report table rations its columns and is its own scrollport.** Under auto
layout the two meters were the only cells that could grow, so they took every
spare pixel while the keyword, the identity of the row, truncated first. The
`colgroup` now sizes every column, the keyword included: left unsized it took
all the slack of a wide screen instead, and a four-letter term sat in a column
three times its own width. With every column sized, fixed layout shares the
spare pixels out in proportion, and the keyword still draws the largest share.
The header sticks to `.table-scroll`, not to the page, and it has to: a
container with `overflow-x: auto` computes `overflow-y` to `auto` too, so it
becomes the nearest scrollport whether or not it scrolls, and a header bound to
a container that never scrolls simply leaves with the rows. That sticky header
is also why anything portalled over the table carries `.ui-layer`: a positioned
element with a z-index paints above every `z-index: auto` one whatever the DOM
order, so a select popup with no layer of its own opens _behind_ the header.

**Every derived number owns a sentence, behind a focusable trigger.** Rank,
change, popularity, difficulty, best/worst, result count and all three tiles
carry an `InfoTip`, because each is a quantity the reader cannot re-derive from
the screen: a difficulty we compute, a popularity Apple publishes for some terms
and not others, a change measured against the previous _different_ rank rather
than against yesterday. The explanation does not live in a `title`, which
neither touch nor the keyboard can reach; `title` stays for the per-row reading
("Search popularity 55 of 100 — Medium"), never for the only statement of what a
column means. A bare mark, the difficulty asterisk included, is a footnote with
no page to turn to.

**The rank chart's x axis is the calendar, never the list of observed days.**
One slot per observed date draws a seven-day cadence gap at the same width as an
overnight step, so every slope across a stretched rung reads wrong and the gap
the ladder deliberately creates disappears. `report.window` carries the
requested window so the axis can span it; `report.dates` stays the sparse
observed set and is not an axis.

The chart separates four states, and collapsing any two of them re-creates the
failure invariant 3 exists to prevent: **ranked** (a point on the line),
**observed but outside the top 200** (`position: null`, on its own rail below
the plot, because it is data), **never collected** (a plain gap, since the
cadence never scheduled that day), and **collected and failed**
(`row.fetchErrors`, a hatched mark on the error rail, so a throttled week cannot
read as a ranking collapse). Series carry a dash pattern as well as a hue, and
the same glyph keys the legend, the table toggle and the line: colour is never
the only channel, and the categorical palette is capped at four because past
that the hues stop surviving a colour-vision check side by side. That cap is
enforced, not merely a default: the table's tick boxes disable once four
keywords are on the chart and say why, rather than accepting a fifth and drawing
it in a hue nobody can separate from the other four. The tick box also has to be
a tick box — a bare swatch only answers "is this on the chart?" after it has
been clicked.
