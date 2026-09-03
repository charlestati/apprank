// Top-chart movement, from `chart_ranking`.
//
// Charts are storefront-wide or per genre, and the source endpoint is recorded
// per observation because the two available feeds do not agree on coverage:
// the `marketingtools` API has no top-grossing and no genre filter, so those
// come from the undocumented legacy RSS feeds. A caller comparing two dates is
// entitled to know whether the same endpoint served both.

export interface ChartMove {
	appId: number;
	name: string | null;
	developer: string | null;
	from: number | null;
	to: number | null;
	/** Positive = climbed toward rank 1. Null when the app entered or left. */
	delta: number | null;
	status: "climbed" | "fell" | "held" | "entered" | "exited";
}

export interface ChartWindow {
	storefront: string;
	chart: string;
	genreId: number | null;
	firstDate: string | null;
	lastDate: string | null;
	observationCount: number;
	sources: string[];
	moves: ChartMove[];
}

interface ChartRow {
	observed_date: string;
	result_ids: string;
	source: string | null;
}

/** Entries and exits are the loudest events, so they sort above a shuffle. */
function moveWeight(move: ChartMove): number {
	return move.delta === null ? Number.MAX_SAFE_INTEGER : Math.abs(move.delta);
}

function positions(row: ChartRow, limit: number): Map<number, number> {
	const ids = JSON.parse(row.result_ids) as number[];
	const map = new Map<number, number>();
	for (const [i, id] of ids.slice(0, limit).entries()) {
		map.set(id, i + 1);
	}
	return map;
}

export async function chartMovement(
	db: D1Database,
	params: {
		storefront: string;
		chart: string;
		genreId: number | null;
		from: string;
		to: string;
		limit: number;
	}
): Promise<ChartWindow> {
	const { storefront, chart, genreId, from, to, limit } = params;
	const rows = await db
		.prepare(
			`SELECT observed_date, result_ids, source
       FROM chart_ranking
       WHERE storefront_code = ?1 AND chart = ?2
         AND genre_id IS ?3
         AND observed_date >= ?4 AND observed_date <= ?5
       ORDER BY observed_date`
		)
		.bind(storefront, chart, genreId, from, to)
		.all<ChartRow>();

	const observations = rows.results;
	const [first] = observations;
	const last = observations.at(-1);
	const empty: ChartWindow = {
		chart,
		firstDate: first?.observed_date ?? null,
		genreId,
		lastDate: last?.observed_date ?? null,
		moves: [],
		observationCount: observations.length,
		sources: [...new Set(observations.map((o) => o.source ?? "unknown"))],
		storefront,
	};
	// One observation describes a board, not a movement across it.
	if (!(first && last) || first === last) {
		return empty;
	}

	const before = positions(first, limit);
	const after = positions(last, limit);
	const appIds = [...new Set([...before.keys(), ...after.keys()])];
	const named = await db
		.prepare(
			`SELECT id, current_name, developer_name FROM app
       WHERE id IN (${appIds.map(() => "?").join(",")})`
		)
		.bind(...appIds)
		.all<{
			id: number;
			current_name: string | null;
			developer_name: string | null;
		}>();
	const byId = new Map(named.results.map((a) => [a.id, a]));

	const moves: ChartMove[] = appIds.map((id) => {
		const start = before.get(id) ?? null;
		const end = after.get(id) ?? null;
		let status: ChartMove["status"] = "held";
		if (start === null) {
			status = "entered";
		} else if (end === null) {
			status = "exited";
		} else if (end < start) {
			status = "climbed";
		} else if (end > start) {
			status = "fell";
		}
		return {
			appId: id,
			delta: start !== null && end !== null ? start - end : null,
			developer: byId.get(id)?.developer_name ?? null,
			from: start,
			name: byId.get(id)?.current_name ?? null,
			status,
			to: end,
		};
	});

	// Biggest movers first.
	moves.sort((a, b) => moveWeight(b) - moveWeight(a));

	return { ...empty, moves };
}
