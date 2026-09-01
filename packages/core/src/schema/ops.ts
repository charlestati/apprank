import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

// A failed fetch is recorded here, never as an observation. Visible gap > silent garbage.
//
// `error_class` is a small closed vocabulary and nothing else: the data-health
// page groups on it, so putting an upstream message here fragments the summary
// into one row per distinct string and buries the counts that matter. The
// message goes in `message`, which is free text and read by humans only.
export const fetchError = sqliteTable("fetch_error", {
  endpoint: text("endpoint").notNull(),
  errorClass: text("error_class"), // 'rate_limited' | 'throttled' | 'http_error' | 'upstream_error' | 'task_threw' | ...
  fetchedAt: integer("fetched_at").notNull(),
  httpStatus: integer("http_status"),
  id: integer("id").primaryKey({ autoIncrement: true }),
  message: text("message"), // upstream body / thrown message, untruncated enough to diagnose
  params: text("params"),
  r2Key: text("r2_key"),
  responseMs: integer("response_ms"),
});

// Proof a scheduled run happened, separate from proof a fetch happened.
//
// Observation rows only ever evidence work that produced data: a daily job
// that died before enqueueing, or a compaction that quietly stopped, leaves no
// trace in them at all. A run that starts and never finishes is exactly the
// signal we were missing, so `finished_at` is deliberately nullable and an
// unfinished row is the alarm.
export const collectorRun = sqliteTable(
  "collector_run",
  {
    detail: text("detail"), // JSON: whatever the job wants read back later
    finishedAt: integer("finished_at"), // NULL = started and never completed
    id: integer("id").primaryKey({ autoIncrement: true }),
    job: text("job").notNull(), // 'daily' | 'cadence' | 'difficulty' | ...
    ok: integer("ok"), // NULL while running
    startedAt: integer("started_at").notNull(),
    trigger: text("trigger").notNull(), // 'cron' | 'admin'
  },
  (t) => [index("cr_started").on(t.startedAt)]
);

// learned_rate, tier2_cursor, window schedule, canary config — survives redeploys.
export const collectorState = sqliteTable("collector_state", {
  key: text("key").primaryKey(),
  updatedAt: integer("updated_at"),
  value: text("value").notNull(),
});

// Tier-2 → Tier-1 promotion is a suggestion the user approves, never
// automatic. A suggestion belongs to whoever tracks the app it concerns:
// promoting a keyword spends that operator's crawl budget, not everyone's.
export const suggestion = sqliteTable("suggestion", {
  createdAt: integer("created_at").notNull(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  status: text("status", { enum: ["pending", "accepted", "dismissed"] })
    .notNull()
    .default("pending"),
  type: text("type").notNull(), // 'promote_pair' | 'untracked_rank' | 'popularity_surge',
  userId: text("user_id").notNull(),
});

// ASC Analytics bookkeeping, incl. detection of Apple's duplicate/skipped
// processingDate defect.
//
// `app_id` is not decoration. Report requests are created per app
// (`tasks/asc.ts` fans out over `tracked_app`), so the app is known at write
// time; dropping it made every row belong to the union of tracked apps. That
// broke both anomaly detectors — one app's report covered another app's
// missing day, and a second app's legitimate report was flagged as the first
// app's `duplicate_date` — and it left first-party analytics with no column
// for `ownsApp` to check. It is also what makes the R2 archive rebuildable
// into this table: the app dimension has to exist in the key and the row, or
// it cannot be recovered.
export const ascReportInstance = sqliteTable(
  "asc_report_instance",
  {
    anomaly: text("anomaly"), // 'duplicate_date' | 'skipped_date' | NULL
    appId: integer("app_id").notNull(),
    checksum: text("checksum"),
    fetchedAt: integer("fetched_at").notNull(),
    granularity: text("granularity").notNull(),
    id: integer("id").primaryKey({ autoIncrement: true }),
    instanceId: text("instance_id"),
    processingDate: text("processing_date").notNull(),
    r2Key: text("r2_key"),
    reportType: text("report_type").notNull(),
  },
  (t) => [
    uniqueIndex("ari_unique").on(
      t.appId,
      t.reportType,
      t.granularity,
      t.processingDate,
      t.instanceId
    ),
  ]
);

// Soft quotas, enforced at the API layer only. NULL = unlimited.
export const userQuota = sqliteTable("user_quota", {
  maxApps: integer("max_apps"),
  maxKeywords: integer("max_keywords"),
  maxStorefrontsPerApp: integer("max_storefronts_per_app"),
  userId: text("user_id").primaryKey(),
});

// Machine credentials for the MCP transport.
//
// Deliberately *not* the Basic accounts. An MCP client is a long-lived agent
// holding a token on disk, and it must not be able to reach the web API with
// it, nor a browser account reach MCP — so the two credential types are
// separate tables of separate shapes, checked by separate gates, and each is
// revocable without touching the other. What they share is the identity:
// `user_id` is the same durable value as `tracked_app.user_id`, so ownership
// answers identically whichever transport asked.
//
// Only the SHA-256 of the secret is stored. `BASIC_AUTH_ACCOUNTS` can hold
// plaintext because it is a Worker secret; this is an ordinary D1 table that
// gets queried, dumped and rebuilt, so the token is shown once at issue and
// never again.
export const mcpCredential = sqliteTable("mcp_credential", {
  /** Public id, carried in the token so a leaked string identifies itself. */
  id: text("id").primaryKey(),
  callCount: integer("call_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"), // NULL = no expiry
  lastUsedAt: integer("last_used_at"),
  /** Which client this is — "charles-laptop", "bob-ci". Named so it can be found. */
  name: text("name").notNull(),
  revokedAt: integer("revoked_at"), // non-NULL = dead on the next call
  scopes: text("scopes").notNull().default('["read:all"]'), // JSON array
  secretHash: text("secret_hash").notNull(),
  userId: text("user_id").notNull(),
  /** Rolling daily budget, so a runaway agent exhausts its own allowance. */
  windowCount: integer("window_count").notNull().default(0),
  windowStart: integer("window_start"),
});

// Every tool call, so a leak can be answered with "what was asked, and by whom".
export const mcpToolCall = sqliteTable(
  "mcp_tool_call",
  {
    calledAt: integer("called_at").notNull(),
    credentialId: text("credential_id").notNull(),
    durationMs: integer("duration_ms"),
    id: integer("id").primaryKey({ autoIncrement: true }),
    outcome: text("outcome", {
      enum: ["ok", "denied", "error", "rate_limited"],
    }).notNull(),
    params: text("params"), // JSON, as validated
    rowCount: integer("row_count"),
    tool: text("tool").notNull(),
    userId: text("user_id").notNull(),
  },
  (t) => [index("mtc_called").on(t.calledAt)]
);
