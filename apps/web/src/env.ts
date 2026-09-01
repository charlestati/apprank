export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  /** The built SPA. The Worker serves it only to authenticated requests. */
  ASSETS: Fetcher;

  // Vars
  APP_URL: string; // e.g. https://apprank.dev
  /**
   * Local development only. With no accounts configured the Worker fails
   * closed; setting this to "true" serves the data to anyone, so it must never
   * be set on a deployed Worker.
   */
  ALLOW_UNAUTHENTICATED?: string;

  /**
   * Secret. JSON array of { username, password, userId? } — see
   * `src/basic-auth.ts`. Never commit it: this repository is public.
   */
  BASIC_AUTH_ACCOUNTS?: string;
  /** Identity assumed when ALLOW_UNAUTHENTICATED is on. Dev only. */
  DEV_USER_ID?: string;

  /**
   * Optional burst brake in front of the MCP gate, keyed per credential.
   *
   * Optional on purpose. The authoritative limit is the daily budget on
   * `mcp_credential`, which is exact; this one is per-colo and, in
   * Cloudflare's own words, "permissive, eventually consistent, and
   * intentionally designed to not be used as an accurate accounting system".
   * What it buys is that a hot retry loop is refused before it reaches D1 at
   * all, so a spent credential cannot burn the write allowance. Miniflare does
   * not provide it, so the code must work without it.
   */
  MCP_RATE_LIMIT?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
}
