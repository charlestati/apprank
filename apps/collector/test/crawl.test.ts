/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { pickDuePair, crawlPair } from "../src/tasks/crawl";
import { fakeSearchResponse, stubFetch } from "./helpers";

const TRACKED_APP = 424_242;

async function seedPairs() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('lu', 'Luxembourg', 0.3, 1)"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (1, 'example keyword', 'example keyword', 'fr')"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 0, 0)"
    ).bind(TRACKED_APP),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
    ).bind(TRACKED_APP),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rank_entry"),
    env.DB.prepare("DELETE FROM ranking"),
    env.DB.prepare("DELETE FROM fetch_error"),
    env.DB.prepare("DELETE FROM crawl_pair"),
    env.DB.prepare("DELETE FROM app_metadata_version"),
    env.DB.prepare("DELETE FROM tracked_app"),
    env.DB.prepare("DELETE FROM app"),
    env.DB.prepare("DELETE FROM keyword"),
  ]);
  await seedPairs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function insertPair(
  id: number,
  overrides: Partial<{
    storefront: string;
    refCount: number;
    tier: number;
    nextDue: number;
    interval: number;
    burstUntil: number | null;
  }> = {}
) {
  const {
    burstUntil = null,
    interval = 24,
    nextDue = 0,
    refCount = 1,
    storefront = "fr",
    tier = 1,
  } = overrides;
  await env.DB.prepare(
    "INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at, burst_until) VALUES (?, 1, ?, 'fr-FR', ?, ?, ?, ?, ?)"
  )
    .bind(id, storefront, tier, refCount, interval, nextDue, burstUntil)
    .run();
}

describe(pickDuePair, () => {
  it("returns null when nothing is due", async () => {
    await insertPair(1, { nextDue: Date.now() + 3_600_000 });
    await expect(pickDuePair(env.DB)).resolves.toBeNull();
  });

  it("ignores retired pairs so their history is kept but never re-crawled", async () => {
    await insertPair(1, { refCount: 0 });
    await expect(pickDuePair(env.DB)).resolves.toBeNull();
  });

  it("ignores Tier-2 pairs: the global sweep never competes for the Tier-1 budget", async () => {
    await insertPair(1, { tier: 2 });
    await expect(pickDuePair(env.DB)).resolves.toBeNull();
  });

  it("prefers the heavier market when two pairs are equally overdue", async () => {
    await insertPair(1, { nextDue: 0, storefront: "lu" });
    await insertPair(2, { nextDue: 0, storefront: "fr" });
    const pair = await pickDuePair(env.DB);
    expect(pair?.id).toBe(2);
    expect(pair?.keyword_text).toBe("example keyword");
  });

  it("lets a burst window jump the queue after a metadata change", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (2, 'second keyword', 'second keyword', 'fr')"
    ).run();
    await insertPair(1, {
      burstUntil: now + 86_400_000,
      nextDue: now - 3_600_000,
    });
    await env.DB.prepare(
      "INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (2, 2, 'fr', 'fr-FR', 1, 1, 24, ?)"
    )
      .bind(now - 3_600_000)
      .run();
    const due = await pickDuePair(env.DB, now);
    expect(due?.id).toBe(1);
  });
});

describe(crawlPair, () => {
  const pair = {
    id: 1,
    interval_hours: 24,
    keyword_text: "example keyword",
    locale_code: "fr-FR",
    storefront_code: "fr",
    weight: 1,
  };

  it("persists the full 200-deep ordered list plus indexed top-10 rows", async () => {
    await insertPair(1);
    stubFetch(() => Response.json(fakeSearchResponse(200)));
    const { throttled } = await crawlPair(env, pair, 3);
    expect(throttled).toBeFalsy();

    const ranking = await env.DB.prepare(
      "SELECT result_count, result_ids, http_status, valid FROM ranking WHERE pair_id = 1"
    ).first<{
      result_count: number;
      result_ids: string;
      http_status: number;
      valid: number;
    }>();
    expect(ranking?.result_count).toBe(200);
    expect(JSON.parse(ranking?.result_ids ?? "[]")).toHaveLength(200);
    expect(ranking?.valid).toBe(1);

    const entries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rank_entry"
    ).first<{ n: number }>();
    expect(entries?.n).toBe(10);
  });

  it("also indexes a tracked app found deep in the results", async () => {
    await insertPair(1);
    const body = fakeSearchResponse(50);
    // Put the tracked app at position 47 — the depth that tells us when a
    // climb started.
    body.results[46] = { ...body.results[46], trackId: TRACKED_APP } as never;
    stubFetch(() => Response.json(body));
    await crawlPair(env, pair, 3);
    const row = await env.DB.prepare(
      "SELECT position FROM rank_entry WHERE app_id = ?"
    )
      .bind(TRACKED_APP)
      .first<{ position: number }>();
    expect(row?.position).toBe(47);
  });

  it("is idempotent: a re-run replaces the day's observation, never duplicates it", async () => {
    await insertPair(1);
    stubFetch(() => Response.json(fakeSearchResponse(5)));
    await crawlPair(env, pair, 3);
    await crawlPair(env, pair, 3);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ranking WHERE pair_id = 1"
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const entries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rank_entry"
    ).first<{ n: number }>();
    expect(entries?.n).toBe(5);
  });

  it("stages the normalised observation for the nightly archive merge", async () => {
    await insertPair(1);
    stubFetch(() => Response.json(fakeSearchResponse(3)));
    await crawlPair(env, pair, 3);
    const date = new Date().toISOString().slice(0, 10);
    const staged = await env.ARCHIVE.get(`staging/rankings/${date}/1.json`);
    const body = JSON.parse((await staged?.text()) ?? "{}");
    expect(body.storefront).toBe("fr");
    expect(body.keyword).toBe("example keyword");
    expect(body.resultIds).toStrictEqual([100, 101, 102]);
    expect(body.collectorVersion).toBeTruthy();
  });

  it("advances next_due_at to the next collection window", async () => {
    await insertPair(1);
    stubFetch(() => Response.json(fakeSearchResponse(1)));
    await crawlPair(env, pair, 3);
    const row = await env.DB.prepare(
      "SELECT next_due_at, last_fetched_at FROM crawl_pair WHERE id = 1"
    ).first<{ next_due_at: number; last_fetched_at: number }>();
    expect(row?.next_due_at).toBeGreaterThan(Date.now());
    expect(row?.last_fetched_at).toBeGreaterThan(0);
    expect(new Date(row?.next_due_at ?? 0).getUTCHours()).toBe(3);
  });

  it("pushes a weekly pair a further day out", async () => {
    await insertPair(1, { interval: 168 });
    stubFetch(() => Response.json(fakeSearchResponse(1)));
    await crawlPair(env, { ...pair, interval_hours: 168 }, 3);
    const row = await env.DB.prepare(
      "SELECT next_due_at FROM crawl_pair WHERE id = 1"
    ).first<{ next_due_at: number }>();
    // 7-day cadence ⇒ at least six extra days beyond tomorrow's window.
    expect((row?.next_due_at ?? 0) - Date.now()).toBeGreaterThan(
      5 * 24 * 3_600_000
    );
  });

  it("never writes an observation for a throttled fetch", async () => {
    await insertPair(1);
    stubFetch(() =>
      Response.json({ resultCount: 0, results: [] }, { status: 403 })
    );
    const { throttled } = await crawlPair(env, pair, 3);
    expect(throttled).toBeTruthy();
    const ranking = await env.DB.prepare(
      "SELECT id FROM ranking WHERE pair_id = 1"
    ).first();
    expect(ranking).toBeNull();
    const err = await env.DB.prepare(
      "SELECT error_class, r2_key FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string; r2_key: string }>();
    expect(err?.error_class).toBe("throttled");
    // The throttle body is archived verbatim for later forensics.
    await expect(env.ARCHIVE.get(err?.r2_key ?? "")).resolves.not.toBeNull();
  });

  it("records a server error, reschedules the pair and writes no observation", async () => {
    await insertPair(1);
    stubFetch(() => new Response("boom", { status: 500 }));
    const { throttled } = await crawlPair(env, pair, 3);
    expect(throttled).toBeFalsy();
    await expect(
      env.DB.prepare("SELECT id FROM ranking WHERE pair_id = 1").first()
    ).resolves.toBeNull();
    const err = await env.DB.prepare(
      "SELECT error_class FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string }>();
    expect(err?.error_class).toBe("http_error");
    const row = await env.DB.prepare(
      "SELECT next_due_at FROM crawl_pair WHERE id = 1"
    ).first<{ next_due_at: number }>();
    expect(row?.next_due_at).toBeGreaterThan(Date.now());
  });

  it("rejects a 200 whose body is not a search response", async () => {
    await insertPair(1);
    stubFetch(() => Response.json({ unexpected: true }));
    await crawlPair(env, pair, 3);
    const err = await env.DB.prepare(
      "SELECT error_class FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string }>();
    expect(err?.error_class).toBe("invalid_body");
  });

  it("samples successful responses verbatim about one time in ten", async () => {
    await insertPair(1);
    stubFetch(() => Response.json(fakeSearchResponse(2)));
    vi.spyOn(Math, "random").mockReturnValue(0.01);
    await crawlPair(env, pair, 3);
    const row = await env.DB.prepare(
      "SELECT r2_key FROM ranking WHERE pair_id = 1"
    ).first<{ r2_key: string | null }>();
    expect(row?.r2_key).toBeTruthy();
    await expect(env.ARCHIVE.get(row?.r2_key ?? "")).resolves.not.toBeNull();
    vi.restoreAllMocks();
  });

  it("keeps no verbatim copy for the other nine in ten", async () => {
    await insertPair(1);
    stubFetch(() => Response.json(fakeSearchResponse(2)));
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    await crawlPair(env, pair, 3);
    const row = await env.DB.prepare(
      "SELECT r2_key FROM ranking WHERE pair_id = 1"
    ).first<{ r2_key: string | null }>();
    expect(row?.r2_key).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("write economy", () => {
  it("refuses to re-crawl a pair already observed today", async () => {
    // The ranking table is unique on (pair_id, observed_date), so a second
    // crawl of the same day overwrites its own row: no new history, a full
    // write set spent. Five manual re-runs in one evening cost ~25,000 writes
    // against a 100,000/day budget before this guard existed.
    await insertPair(1);
    await env.DB.prepare(
      "INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid) VALUES (1, ?, 0, 200, 5, '[]', 'test', 1)"
    )
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    await expect(pickDuePair(env.DB)).resolves.toBeNull();
  });

  it("still offers a pair whose only observation is from another day", async () => {
    await insertPair(1);
    await env.DB.prepare(
      "INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid) VALUES (1, '2020-01-01', 0, 200, 5, '[]', 'test', 1)"
    ).run();
    await expect(pickDuePair(env.DB)).resolves.not.toBeNull();
  });
});
