// The SchedulerDO work loop processes one task step per alarm tick. A step does
// bounded work (well under the 50-subrequest / 10ms-CPU free limits) and may
// return follow-up tasks. Everything a step writes must be idempotent: alarms
// are at-least-once.

export type Task =
  | {
      type: "asc_poll";
      stage?: "init" | "reports" | "instances";
      appId?: string; // App Store id, from the tracked_app table — never config
      requestId?: string;
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
      verifyOnly?: boolean;
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
  /** Top-level genre id — the granularity Apple Ads popularity actually has. */
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
