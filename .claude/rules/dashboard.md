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
the only channel, and the categorical palette is capped at four by default
because past that the hues stop surviving a colour-vision check side by side.
