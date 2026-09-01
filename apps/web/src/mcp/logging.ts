// Tool-call audit and the shared shape every tool answers in.
//
// Every call is recorded with who asked, what they asked, how many rows came
// back and how long it took — the questions worth being able to answer after a
// leak, none of which the observation tables can answer on their own.
//
// The wrapper is also where scope and ownership failures are turned into a
// reply rather than a stack trace: a tool that throws would surface an internal
// message to the model, and a tool that swallowed the failure would look like
// an empty result. Neither is honest.

import type { Principal } from "./auth";
import { hasScope } from "./auth";

/** Raised when the caller does not track the app or pair being asked about. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ScopeError extends Error {
  constructor(scope: string) {
    super(`This credential does not carry the ${scope} scope.`);
    this.name = "ScopeError";
  }
}

export interface ToolOutcome {
  data: unknown;
  rowCount: number;
}

export interface ToolContext {
  db: D1Database;
  principal: Principal;
  waitUntil: (p: Promise<unknown>) => void;
}

/** How long the audit log is kept before an opportunistic prune drops it. */
const LOG_RETENTION_DAYS = 90;
/** Prune odds per call: often enough to bound the table, rare enough to be free. */
const PRUNE_EVERY = 50;

interface LogEntry {
  tool: string;
  params: unknown;
  rowCount: number | null;
  durationMs: number;
  outcome: "ok" | "denied" | "error" | "rate_limited";
}

export async function recordToolCall(
  db: D1Database,
  principal: Principal,
  entry: LogEntry
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mcp_tool_call
         (called_at, credential_id, user_id, tool, params, row_count, duration_ms, outcome)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      Date.now(),
      principal.credentialId,
      principal.userId,
      entry.tool,
      JSON.stringify(entry.params ?? {}),
      entry.rowCount,
      entry.durationMs,
      entry.outcome
    )
    .run();
}

function pruneLog(db: D1Database): Promise<unknown> {
  return db
    .prepare("DELETE FROM mcp_tool_call WHERE called_at < ?1")
    .bind(Date.now() - LOG_RETENTION_DAYS * 86_400_000)
    .run();
}

function reply(payload: unknown, isError = false) {
  return {
    content: [
      { text: JSON.stringify(payload, null, 2), type: "text" as const },
    ],
    isError,
  };
}

/**
 * Wrap a tool body with scope enforcement, timing, audit and error shaping.
 *
 * A `NotFoundError` answers with the same message whether the resource is
 * absent or simply someone else's — the HTTP API answers 404 rather than 403
 * for the same reason, since confirming that an id exists is itself
 * information about another operator's account.
 */
export function audited<A>(
  name: string,
  scope: string | null,
  body: (args: A, ctx: ToolContext) => Promise<ToolOutcome>
) {
  return async (args: A, ctx: ToolContext) => {
    const startedAt = Date.now();
    const finish = (
      outcome: LogEntry["outcome"],
      rowCount: number | null
    ): void => {
      ctx.waitUntil(
        recordToolCall(ctx.db, ctx.principal, {
          durationMs: Date.now() - startedAt,
          outcome,
          params: args,
          rowCount,
          tool: name,
        })
      );
      if (Math.random() < 1 / PRUNE_EVERY) {
        ctx.waitUntil(pruneLog(ctx.db));
      }
    };

    // `scope: null` means the tool describes the credential itself rather than
    // any data, so a credential with no usable scope can still call it.
    if (scope !== null && !hasScope(ctx.principal, scope)) {
      finish("denied", null);
      return reply({ error: new ScopeError(scope).message }, true);
    }

    try {
      const outcome = await body(args, ctx);
      finish("ok", outcome.rowCount);
      return reply(outcome.data);
    } catch (error) {
      const notFound = error instanceof NotFoundError;
      finish(notFound ? "denied" : "error", null);
      return reply(
        {
          error: notFound
            ? (error as Error).message
            : `The tool failed: ${(error as Error).message}`,
        },
        true
      );
    }
  };
}
