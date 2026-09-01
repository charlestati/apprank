// The MCP transport's credential gate.
//
// This runs *before* the MCP handler is constructed, so an unauthenticated
// request never reaches tool code — not even a misregistered tool. The gate is
// the only thing that produces a `Principal`, and a tool cannot be called
// without one, so "every tool call resolves to a known principal" is a
// property of the wiring rather than a rule each tool has to remember.
//
// Deliberately separate from HTTP Basic. A token issued here is useless
// against `/api/*`, because that gate only reads `Basic ` headers; a browser
// account is useless here, because this one only reads `Bearer `. Two
// credential types, two gates, independently revocable — which is what stops a
// long-lived agent token from becoming a skeleton key for the whole origin.

import { digest, timingSafeEqual } from "../lib/crypto";

/** Token shape: a leaked string should say what it is and where it came from. */
const TOKEN_PREFIX = "apprank_mcp_";

/**
 * Tool calls allowed per credential per rolling day.
 *
 * The point is containment, not thrift: an agent stuck in a loop should
 * exhaust its own allowance long before it eats the account's D1 read budget.
 */
export const DAILY_CALL_BUDGET = 2000;

const DAY_MS = 86_400_000;

export interface Principal {
  credentialId: string;
  name: string;
  userId: string;
  scopes: string[];
  callsRemainingToday: number;
  expiresAt: number | null;
}

export type AuthFailure =
  | "missing"
  | "malformed"
  | "unknown"
  | "revoked"
  | "expired"
  | "rate_limited";

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: AuthFailure };

interface CredentialRow {
  id: string;
  name: string;
  user_id: string;
  scopes: string;
  secret_hash: string;
  expires_at: number | null;
  revoked_at: number | null;
  window_start: number | null;
  window_count: number;
}

/** "Bearer apprank_mcp_<id>_<secret>" → its two halves. */
export function parseToken(
  header: string | null
): { id: string; secret: string } | null {
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  // First separator only: the id is hex, but the secret is base64url and
  // routinely contains underscores of its own. Splitting on the last one, or
  // on all of them, would corrupt most secrets.
  const separator = rest.indexOf("_");
  if (separator <= 0) {
    return null;
  }
  const id = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  return secret.length > 0 ? { id, secret } : null;
}

export function formatToken(id: string, secret: string): string {
  return `${TOKEN_PREFIX}${id}_${secret}`;
}

export async function hashSecret(secret: string): Promise<string> {
  return [...(await digest(secret))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Charge one call against the credential's rolling day and stamp last-used.
 *
 * One statement, because the write is owed anyway: `last_used_at` is what
 * makes a forgotten credential findable, so the budget rides along on it
 * rather than costing a second round trip. `RETURNING` gives the post-increment
 * count without a follow-up read.
 */
async function chargeCall(
  db: D1Database,
  id: string,
  now: number
): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE mcp_credential
         SET window_start = CASE WHEN window_start IS NULL OR window_start < ?2
                                 THEN ?3 ELSE window_start END,
             window_count = CASE
                              WHEN window_start IS NULL OR window_start < ?2 THEN 1
                              -- Stop counting once over: a loop that keeps
                              -- retrying a spent credential must not keep
                              -- growing the number it is judged against.
                              WHEN window_count > ?4 THEN window_count
                              ELSE window_count + 1
                            END,
             call_count = call_count + 1,
             last_used_at = ?3
       WHERE id = ?1
       RETURNING window_count`
    )
    .bind(id, now - DAY_MS, now, DAILY_CALL_BUDGET)
    .first<{ window_count: number }>();
  return row?.window_count ?? 0;
}

/**
 * Resolve a credential, or say why not.
 *
 * An unknown id still pays for a digest, so "no such credential" and "wrong
 * secret" cost the same and the id space cannot be probed by timing.
 */
export async function authenticateMcp(
  db: D1Database,
  header: string | null,
  now: number = Date.now()
): Promise<AuthResult> {
  const parsed = parseToken(header);
  if (!parsed) {
    return { ok: false, reason: header ? "malformed" : "missing" };
  }

  const row = await db
    .prepare(
      `SELECT id, name, user_id, scopes, secret_hash, expires_at, revoked_at,
              window_start, window_count
       FROM mcp_credential WHERE id = ?1`
    )
    .bind(parsed.id)
    .first<CredentialRow>();

  const given = await hashSecret(parsed.secret);
  const expected = row?.secret_hash ?? "no-such-credential";
  const encoder = new TextEncoder();
  const matches = timingSafeEqual(
    encoder.encode(given),
    encoder.encode(expected)
  );
  if (!(row && matches)) {
    return { ok: false, reason: "unknown" };
  }

  // Checked after the compare so a revoked or expired id is not distinguishable
  // from an unknown one by anybody who does not already hold the secret.
  if (row.revoked_at !== null) {
    return { ok: false, reason: "revoked" };
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    return { ok: false, reason: "expired" };
  }

  const used = await chargeCall(db, row.id, now);
  if (used > DAILY_CALL_BUDGET) {
    return { ok: false, reason: "rate_limited" };
  }

  let scopes: string[] = [];
  try {
    const parsedScopes: unknown = JSON.parse(row.scopes);
    scopes = Array.isArray(parsedScopes) ? (parsedScopes as string[]) : [];
  } catch {
    // A malformed scope list grants nothing rather than everything.
    scopes = [];
  }

  return {
    ok: true,
    principal: {
      callsRemainingToday: Math.max(0, DAILY_CALL_BUDGET - used),
      credentialId: row.id,
      expiresAt: row.expires_at,
      name: row.name,
      scopes,
      userId: row.user_id,
    },
  };
}

/** Scope check. `read:all` is the umbrella the issuing script grants by default. */
export function hasScope(principal: Principal, scope: string): boolean {
  return (
    principal.scopes.includes("read:all") || principal.scopes.includes(scope)
  );
}
