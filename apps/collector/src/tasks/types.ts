// The SchedulerDO work loop processes one task step per alarm tick. A step
// does bounded work (well under the 50-subrequest / 10ms-CPU free limits) and
// may return follow-up tasks. Everything a step writes must be idempotent:
// alarms are at-least-once.

/**
 * What the scheduler stamps on every queued task, beside the step's own shape.
 *
 * `id` is how a finished step finds itself again. A step awaits Apple and D1,
 * and while it does the object's input gate is open, so `enqueue` and
 * `stepNow` can change the queue underneath it; writing back the copy read
 * before the step erased whatever arrived meanwhile (the 03:00 cron's tasks
 * among them). Tasks queued before ids existed get one on first read.
 *
 * `threw` counts throws, apart from `attempt`, which the steps own and spend
 * on throttles and rate limits. Sharing one counter let two throttles and a
 * single throw drop a whole batch.
 */
interface TaskMeta {
	id?: string;
	threw?: number;
}

export type Task = TaskMeta & TaskBody;

type TaskBody =
	| {
			type: "asc_poll";
			stage?: "init" | "reports" | "instances";
			appId?: string | undefined; // App Store id, from the tracked_app table, never config
			requestId?: string | undefined;
			reportQueue?: AscReportRef[];
			attempt?: number;
	  }
	| {
			type: "asc_fetch_instance";
			/** App Store id. Report requests are per app, so every instance has one. */
			appId: string;
			report: AscReportRef;
			instanceId: string;
			granularity: string;
			processingDate: string;
			attempt?: number;
	  }
	| {
			type: "ads_pull";
			queue: AdsPullUnit[];
			weekStart: string;
			attempt?: number;
			/**
			 * Fetch and archive, but write no rows. A credential check only needs to
			 * know Apple answered; making it rewrite 500 terms per unit spent a
			 * meaningful slice of the daily write budget to learn nothing new.
			 */
			verifyOnly?: boolean | undefined;
	  }
	| {
			type: "ads_terms";
			/** Lowercase storefront code; popularity is per country, not per locale. */
			storefront: string;
			weekStart: string;
			/** Normalized keyword texts still to ask Apple about, oldest chunk first. */
			terms: string[];
			attempt?: number;
			/** As on `ads_pull`: archive the answer, write no rows. */
			verifyOnly?: boolean | undefined;
	  }
	| {
			type: "ads_discover";
			/** App Store (Adam) id: Apple scopes suggestions to one promoted app. */
			appAdamId: string;
			/** Who the suggestions belong to, and which tracked app they concern. */
			userId: string;
			appId: number;
			storefront: string;
			localeCode: string;
			language: string;
			/** The seed for this tick, then the seeds still to come. */
			seed: string;
			rest: string[];
			attempt?: number;
			/** Fetch and archive, propose nothing. */
			verifyOnly?: boolean | undefined;
	  }
	| { type: "lookup_pull"; queue: LookupUnit[]; attempt?: number }
	| { type: "review_pull"; queue: ReviewUnit[]; attempt?: number }
	| { type: "chart_pull"; queue: ChartUnit[]; attempt?: number }
	| { type: "compact"; date: string; attempt?: number };

export interface AscReportRef {
	reportId: string;
	name: string;
	category: string;
}

export interface AdsPullUnit {
	storefront: string; // lowercase code, e.g. 'fr'
	/** Top-level genre id: the granularity Apple Ads popularity actually has. */
	genreId: number;
	/** Apple Ads category enum, e.g. 'GAMES'. */
	category: string;
}

export interface LookupUnit {
	appId: number;
	storefront: string;
	localeCode: string;
}

export interface ReviewUnit {
	appId: number;
	storefront: string;
}

export interface ChartUnit {
	storefront: string;
	genreId: number | null;
	chart: "free" | "paid" | "grossing";
}
