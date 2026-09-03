// How much a search result page moves between two observations of the same
// pair, measured by depth.
//
// Why this exists: a rank deep in the page is only worth plotting if the page
// is stable enough that a change means something. That is a question about the
// data, so it gets an answer from the data rather than a threshold somebody
// picked.
//
// What it can and cannot see. Measured over the archive, pages collected from
// the same client are stable day to day, including the tail. Pages of the same
// term fetched from a *different* network are not: the top ten still matches
// exactly, while roughly a fifth of the rest differs. So the ranks a run
// produces are comparable with the ranks of every other run, which is what
// tracking movement needs, and are not comparable with what a user on another
// network sees. This script measures the first and is blind to the second,
// because every row it reads came from the same collector.

/**
 * Depth bands, by position on the earlier day. Uneven on purpose: the
 * interesting behaviour is concentrated near the top, where a few places matter,
 * and the tail only needs to be coarse enough to show the floor.
 */
export const DEPTH_BANDS = [
	[1, 10],
	[11, 25],
	[26, 50],
	[51, 100],
	[101, 150],
	[151, 200],
];

function bandOf(position) {
	return DEPTH_BANDS.find(([lo, hi]) => position >= lo && position <= hi);
}

function quantile(sorted, q) {
	if (sorted.length === 0) {
		return null;
	}
	const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[i];
}

/**
 * Compare one pair's list on two days.
 *
 * `depthLimit` is the crux. `ranking.result_ids` holds at most 200 ids and a
 * page routinely returns fewer, so an app that sat at 180 yesterday and is
 * absent from a 150-app page today has not necessarily moved: the page simply
 * does not reach that far. Counting that as a drop would manufacture exactly the
 * churn this script exists to measure. Only positions both pages could have
 * expressed are compared.
 */
export function comparePair(before, after) {
	const depthLimit = Math.min(before.length, after.length);
	const index = new Map(after.map((id, i) => [id, i + 1]));
	const moves = [];
	const drops = [];
	for (let i = 0; i < depthLimit; i += 1) {
		const position = i + 1;
		const found = index.get(before[i]);
		if (found === undefined) {
			drops.push(position);
		} else {
			moves.push({ delta: Math.abs(found - position), position });
		}
	}
	return { depthLimit, drops, moves };
}

/**
 * @param {{pairId: number, date: string, ids: number[]}[]} observations One
 *   stored result page per pair per day.
 * @param {{maxDaysApart?: number}} options Widen `maxDaysApart` to include
 *   pairs on the slower rungs of the cadence ladder.
 *
 * Consecutive *observations*, not consecutive days: the cadence ladder puts
 * pairs on 1, 2, 3 and 7 day rungs, so a gap is normal and says nothing about
 * the page. Comparing across a seven-day gap would overstate the churn of a
 * daily pair, so the default only accepts same-day-to-next-day pairs.
 */
export function measure(observations, { maxDaysApart = 1 } = {}) {
	const byPair = new Map();
	for (const o of observations) {
		if (!byPair.has(o.pairId)) {
			byPair.set(o.pairId, []);
		}
		byPair.get(o.pairId).push(o);
	}

	const bands = new Map(
		DEPTH_BANDS.map((b) => [b.join("-"), { drops: 0, deltas: [], seen: 0 }])
	);
	let comparisons = 0;

	for (const list of byPair.values()) {
		list.sort((a, b) => a.date.localeCompare(b.date));
		for (let i = 1; i < list.length; i += 1) {
			const before = list[i - 1];
			const after = list[i];
			const apart = Math.round(
				(Date.parse(`${after.date}T00:00:00Z`) -
					Date.parse(`${before.date}T00:00:00Z`)) /
					86_400_000
			);
			if (apart < 1 || apart > maxDaysApart) {
				continue;
			}
			comparisons += 1;
			const { moves, drops } = comparePair(before.ids, after.ids);
			for (const m of moves) {
				const band = bandOf(m.position);
				if (band) {
					const b = bands.get(band.join("-"));
					b.seen += 1;
					b.deltas.push(m.delta);
				}
			}
			for (const position of drops) {
				const band = bandOf(position);
				if (band) {
					const b = bands.get(band.join("-"));
					b.seen += 1;
					b.drops += 1;
				}
			}
		}
	}

	const rows = [...bands.entries()].map(([band, b]) => {
		const sorted = b.deltas.toSorted((x, y) => x - y);
		return {
			band,
			dropRate: b.seen === 0 ? null : b.drops / b.seen,
			medianMove: quantile(sorted, 0.5),
			p90Move: quantile(sorted, 0.9),
			samples: b.seen,
		};
	});
	return { comparisons, pairs: byPair.size, rows };
}

/**
 * The shallowest band whose drop rate crosses `limit`, and therefore the depth
 * past which "not ranking" stops being a statement about the app.
 *
 * Returns null when no band crosses it, which is the answer worth having too:
 * it means the page held together at every depth observed and the cutoff is
 * below the data, not inside it.
 */
export function noiseFloor(rows, limit = 0.1) {
	const hit = rows.find((r) => r.dropRate !== null && r.dropRate >= limit);
	return hit ? Number(hit.band.split("-")[0]) : null;
}
