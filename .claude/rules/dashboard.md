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
no page to turn to, so the asterisk, the "~" unproven mark and the contested
arrow are the same trigger (`Hint` in `components/info-tip.tsx`). That trigger
is a Base UI **popover with `openOnHover`, not a tooltip**: a tooltip opens on
mouse hover and keyboard focus only, and a tap is neither, so on a phone every
"?" was a button that did nothing. The difficulty footnote sits beside its
meter, never inside it, because the children of `role="meter"` are
presentational. A toggle keeps one name and carries its state in `aria-pressed`;
a name that flips with the state reads "Hide X, pressed".

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
been clicked. The cap is counted on what is drawn, never on the stored list: a
stored selection is filtered to the pairs the report has rows for and sliced to
four, so a selection saved before the cap, or one naming a pair that has gone,
can neither draw a fifth line nor make a chart showing three refuse a fourth.

The table keeps the same states apart, and `position: null` alone cannot: the
server sends it both for "observed outside the top 200" and for a keyword with
no observation in the window (`points: []`, verdict `noObservation`). The first
keeps its dash. The second prints a word, "no data", or "failed" when
`fetchErrors` is not empty, in the rank and best/worst cells, because a dash
there told the reader a throttled week was a keyword that had stopped ranking.

Marks that share a slot are never nudged apart, since a nudge states a date or a
rank the data does not have: ranked dots on one point become rings, keywords
outside the top 200 on one day become hollow squares on the rail, a day that
failed with two error classes is one hatched mark naming both, and two releases
captured on one day keep one rule with their tags side by side. Release pins are
focused by index, not by date, for the same reason. A muted series keeps its
lone dots, in the neutral colour: a pair on a stretched cadence is nothing but
lone dots, and dropping them made it vanish. With no crosshair yet, the first
arrow key lands on the newest day.

The pair page draws the same four states. `/pairs/:id/history` answers
`{ points, fetchErrors, window }`, the pair's failed crawls joined the way the
report joins them, and without `appId` it reads the one app the caller tracks
that keyword for (400 when there are several, rather than guessing). The window
keeps the days since the last observation on the axis as a gap.

**Every fetch is stamped with what it answers.** The report, the storefront
choice, reviews and pair history are held with the app (and storefront, window
or pair) they were fetched for and read back only while that still matches.
Switching app therefore shows the loading state, never the previous app's
numbers under the new name and CSV link, and an answer that lands after the
reader moved on is dropped rather than drawn. The storefront choice survives an
app switch only where the new app is tracked too; carrying it over blindly asked
for a report the new app has no pairs for.

**A failed request is its own state, never the empty one.** "Nothing collected
yet", "nothing pending" and "the collector fills this in daily" are claims about
the data, and a 500 supports none of them, so the pair, health, reviews and
suggestions pages each say the load failed. The same goes for "not answered
yet": the app list is null until it answers, because starting from an empty
array printed "No app is being tracked yet." on every load, and the report page
tells an empty storefront list from a failed one instead of waiting for a report
nobody asked for. The shell starts its four requests together.

Stored preferences are read once per page load and shared (`loadPreferences`),
with this session's own writes laid over the answer, so a read that left before
a click cannot undo the click.
