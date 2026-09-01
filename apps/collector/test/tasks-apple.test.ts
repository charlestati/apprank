/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { adsPullStep, latestCompleteWeekStart } from "../src/tasks/ads";
import {
  ascPollStep,
  ascFetchInstanceStep,
  ascDetectSkippedDates,
} from "../src/tasks/asc";
import type { Task } from "../src/tasks/types";
import { generateP8Pem, stubFetch } from "./helpers";

const APP_ID = 424_242;
/** A second tracked app: the dimension the ASC bookkeeping used to collapse. */
const OTHER_APP_ID = 515_151;
let pem = "";

beforeEach(async () => {
  ({ pem } = await generateP8Pem());
  await env.DB.batch([
    env.DB.prepare("DELETE FROM collector_state"),
    env.DB.prepare("DELETE FROM fetch_error"),
    env.DB.prepare("DELETE FROM popularity"),
    env.DB.prepare("DELETE FROM seed_term"),
    env.DB.prepare("DELETE FROM asc_report_instance"),
    env.DB.prepare("DELETE FROM crawl_pair"),
    env.DB.prepare("DELETE FROM keyword"),
    env.DB.prepare("DELETE FROM tracked_app"),
    env.DB.prepare("DELETE FROM app"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
    ),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function adsEnv() {
  return {
    ...env,
    ADS_CLIENT_ID: "client",
    ADS_KEY_ID: "key",
    ADS_PRIVATE_KEY: pem,
    ADS_TEAM_ID: "team",
  };
}

function ascEnv() {
  return {
    ...env,
    ASC_ISSUER_ID: "issuer",
    ASC_KEY_ID: "key",
    ASC_PRIVATE_KEY: pem,
  };
}

describe(latestCompleteWeekStart, () => {
  it("returns a Sunday at least a fortnight back, covering Apple's posting delay", () => {
    const d = new Date(
      latestCompleteWeekStart(new Date("2026-09-01T12:00:00Z"))
    );
    expect(d.getUTCDay()).toBe(0);
    const daysBack =
      (Date.parse("2026-09-01T12:00:00Z") - d.getTime()) / 86_400_000;
    expect(daysBack).toBeGreaterThanOrEqual(7);
  });
});

describe(adsPullStep, () => {
  it("returns nothing for an empty queue", async () => {
    await expect(
      adsPullStep(adsEnv(), {
        queue: [],
        type: "ads_pull",
        weekStart: "2026-08-16",
      })
    ).resolves.toStrictEqual([]);
  });

  it("archives the raw response, seeds Tier 2 and records tracked-keyword popularity", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO keyword (id, text, normalized, language) VALUES (1, 'mots croisés', 'mots croisés', 'fr')"
      ),
      env.DB.prepare(
        "INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 24, 0)"
      ),
    ]);
    stubFetch((url) => {
      if (url.includes("appleid.apple.com")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v1/acls")) {
        return Response.json({ data: { acls: [{ adAccount: { id: 777 } }] } });
      }
      return Response.json({
        result: {
          rows: [
            {
              rankInGenre: 3,
              searchPopularity1to100: 62,
              searchPopularity1to5: 4,
              searchTerm: "mots croisés",
            },
            {
              rankInGenre: 9,
              searchPopularity1to100: 40,
              searchTerm: "other term",
            },
          ],
        },
      });
    });

    const followUps = await adsPullStep(adsEnv(), {
      queue: [{ category: "GAMES", genreId: 6014, storefront: "fr" }],
      type: "ads_pull",
      weekStart: "2026-08-16",
    });
    expect(followUps).toStrictEqual([]);

    const archived = await env.ARCHIVE.get(
      "ads/popularity/2026-08-16/fr/GAMES.json"
    );
    expect(archived).not.toBeNull();

    const seeds = await env.DB.prepare(
      "SELECT term, rank_in_genre FROM seed_term ORDER BY rank_in_genre"
    ).all<{ term: string; rank_in_genre: number }>();
    expect(seeds.results.map((s) => s.term)).toStrictEqual([
      "mots croisés",
      "other term",
    ]);

    const pop = await env.DB.prepare(
      "SELECT present, popularity_1_100, popularity_1_5 FROM popularity WHERE keyword_id = 1"
    ).first<{
      present: number;
      popularity_1_100: number;
      popularity_1_5: number;
    }>();
    expect(pop).toStrictEqual({
      popularity_1_100: 62,
      popularity_1_5: 4,
      present: 1,
    });
  });

  it("marks tracked keywords absent from Apple's list as 'no data', not low popularity", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO keyword (id, text, normalized, language) VALUES (2, 'long tail term', 'long tail term', 'fr')"
      ),
      env.DB.prepare(
        "INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (2, 2, 'fr', 'fr-FR', 1, 1, 24, 0)"
      ),
    ]);
    stubFetch((url) => {
      if (url.includes("appleid.apple.com")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v1/acls")) {
        return Response.json({ data: { acls: [{ adAccount: { id: 777 } }] } });
      }
      return Response.json({ result: { rows: [] } });
    });
    await adsPullStep(adsEnv(), {
      queue: [{ category: "GAMES", genreId: 6014, storefront: "fr" }],
      type: "ads_pull",
      weekStart: "2026-08-16",
    });
    const pop = await env.DB.prepare(
      "SELECT present, popularity_1_100 FROM popularity WHERE keyword_id = 2"
    ).first<{ present: number; popularity_1_100: number | null }>();
    expect(pop?.present).toBe(0);
    expect(pop?.popularity_1_100).toBeNull();
  });

  it("caches the discovered ad account id", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("appleid.apple.com")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v1/acls")) {
        return Response.json({ data: { acls: [{ adAccount: { id: 777 } }] } });
      }
      return Response.json({ result: { rows: [] } });
    });
    const task: Task = {
      queue: [
        { category: "GAMES", genreId: 6014, storefront: "fr" },
        { category: "GAMES", genreId: 6014, storefront: "be" },
      ],
      type: "ads_pull",
      weekStart: "2026-08-16",
    };
    const next = await adsPullStep(adsEnv(), task as never);
    await adsPullStep(adsEnv(), next[0] as never);
    await expect(
      env.DB.prepare(
        "SELECT value FROM collector_state WHERE key = 'ads:ad_account_id'"
      ).first<{ value: string }>()
    ).resolves.toStrictEqual({ value: "777" });
    // Discovery happens once, not per unit.
    expect(calls.filter((c) => c.url.includes("/v1/acls"))).toHaveLength(1);
  });

  it("requeues the unit and logs a 429 without losing the queue", async () => {
    stubFetch((url) => {
      if (url.includes("appleid.apple.com")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v1/acls")) {
        return Response.json({ data: { acls: [{ adAccount: { id: 777 } }] } });
      }
      return new Response("", {
        headers: { "Retry-After": "60" },
        status: 429,
      });
    });
    const followUps = await adsPullStep(adsEnv(), {
      queue: [{ category: "GAMES", genreId: 6014, storefront: "fr" }],
      type: "ads_pull",
      weekStart: "2026-08-16",
    });
    expect(followUps[0]).toMatchObject({ attempt: 1, type: "ads_pull" });
    const err = await env.DB.prepare(
      "SELECT error_class, http_status FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string; http_status: number }>();
    expect(err?.error_class).toBe("rate_limited");
    expect(err?.http_status).toBe(429);
  });

  it("skips a failing unit and keeps the rest of the queue moving", async () => {
    stubFetch(() => new Response("no account", { status: 401 }));
    const followUps = await adsPullStep(adsEnv(), {
      queue: [
        { category: "GAMES", genreId: 6014, storefront: "fr" },
        { category: "GAMES", genreId: 6014, storefront: "be" },
      ],
      type: "ads_pull",
      weekStart: "2026-08-16",
    });
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ type: "ads_pull" });
    const err = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM fetch_error"
    ).first<{ n: number }>();
    expect(err?.n).toBe(1);
  });
});

describe(ascPollStep, () => {
  it("fans out one poll per tracked app, reading the app list from the database", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 0, 0)"
      ).bind(APP_ID),
      env.DB.prepare(
        "INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
      ).bind(APP_ID),
    ]);
    const followUps = await ascPollStep(ascEnv(), { type: "asc_poll" });
    expect(followUps).toStrictEqual([
      { appId: String(APP_ID), stage: "init", type: "asc_poll" },
    ]);
  });

  it("creates the ONGOING request and fires the one-time history snapshot once", async () => {
    const calls = stubFetch((url, init) => {
      if (init?.method === "POST") {
        return Response.json({
          data: { attributes: { accessType: "ONGOING" }, id: "req-1" },
        });
      }
      if (url.includes("analyticsReportRequests")) {
        return Response.json({ data: [] });
      }
      return Response.json({ data: [] });
    });

    const first = await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      stage: "init",
      type: "asc_poll",
    });
    expect(first[0]).toMatchObject({ stage: "reports", type: "asc_poll" });
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(2); // ONGOING + ONE_TIME_SNAPSHOT
    await expect(
      env.DB.prepare(
        `SELECT value FROM collector_state WHERE key = 'asc:${APP_ID}:snapshot_requested'`
      ).first()
    ).resolves.not.toBeNull();

    // Second run: the snapshot is not requested again.
    const secondCalls = stubFetch((url, init) =>
      init?.method === "POST"
        ? Response.json({
            data: { attributes: { accessType: "ONGOING" }, id: "req-1" },
          })
        : Response.json({
            data: [{ attributes: { accessType: "ONGOING" }, id: "req-1" }],
          })
    );
    await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      stage: "init",
      type: "asc_poll",
    });
    expect(secondCalls.filter((c) => c.init?.method === "POST")).toHaveLength(
      0
    );
  });

  it("flags an ONGOING request that Apple stopped for inactivity", async () => {
    stubFetch((url, init) =>
      init?.method === "POST"
        ? Response.json({
            data: { attributes: { accessType: "ONGOING" }, id: "req-2" },
          })
        : Response.json({
            data: [
              {
                attributes: {
                  accessType: "ONGOING",
                  stoppedDueToInactivity: true,
                },
                id: "dead",
              },
            ],
          })
    );
    await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      stage: "init",
      type: "asc_poll",
    });
    const err = await env.DB.prepare(
      "SELECT error_class FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string }>();
    expect(err?.error_class).toBe("stopped_due_to_inactivity");
  });

  it("dumps the report list once and queues only the wanted categories", async () => {
    stubFetch(() =>
      Response.json({
        data: [
          {
            attributes: {
              category: "APP_STORE_ENGAGEMENT",
              name: "Discovery",
            },
            id: "rep-1",
          },
          {
            attributes: { category: "FRAMEWORK_USAGE", name: "Frameworks" },
            id: "rep-2",
          },
        ],
      })
    );
    const followUps = await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      requestId: "req-1",
      stage: "reports",
      type: "asc_poll",
    });
    expect(followUps[0]).toMatchObject({ stage: "instances" });
    const queued = (followUps[0] as { reportQueue: { name: string }[] })
      .reportQueue;
    expect(queued.map((r) => r.name)).toStrictEqual(["Discovery"]);
    await expect(
      env.ARCHIVE.get(`asc/${APP_ID}/report-list-req-1.json`)
    ).resolves.not.toBeNull();
  });

  it("restarts at init when no ongoing request id is known", async () => {
    const followUps = await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      stage: "reports",
      type: "asc_poll",
    });
    expect(followUps).toStrictEqual([
      { appId: String(APP_ID), stage: "init", type: "asc_poll" },
    ]);
  });

  it("queues unseen instances and chains the remaining reports", async () => {
    stubFetch(() =>
      Response.json({
        data: [
          {
            attributes: { granularity: "DAILY", processingDate: "2026-08-30" },
            id: "inst-1",
          },
        ],
      })
    );
    const followUps = await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      reportQueue: [
        { category: "APP_STORE_ENGAGEMENT", name: "A", reportId: "rep-1" },
        { category: "APP_STORE_ENGAGEMENT", name: "B", reportId: "rep-2" },
      ],
      requestId: "req-1",
      stage: "instances",
      type: "asc_poll",
    });
    expect(followUps[0]).toMatchObject({
      instanceId: "inst-1",
      type: "asc_fetch_instance",
    });
    expect(followUps[1]).toMatchObject({
      stage: "instances",
      type: "asc_poll",
    });
  });

  it("returns nothing when the report queue is exhausted", async () => {
    const followUps = await ascPollStep(ascEnv(), {
      appId: String(APP_ID),
      reportQueue: [],
      stage: "instances",
      type: "asc_poll",
    });
    expect(followUps).toStrictEqual([]);
  });
});

describe(ascFetchInstanceStep, () => {
  const report = {
    category: "APP_STORE_ENGAGEMENT",
    name: "App Store Discovery and Engagement",
    reportId: "rep-1",
  };

  it("stores every segment verbatim and records the instance", async () => {
    stubFetch((url) =>
      url.includes("presigned")
        ? new Response("gz-bytes")
        : Response.json({
            data: [
              {
                attributes: {
                  checksum: "abc",
                  sizeInBytes: 10,
                  url: "https://presigned.example/1.gz",
                },
                id: "seg-1",
              },
            ],
          })
    );
    await ascFetchInstanceStep(ascEnv(), {
      appId: String(APP_ID),
      granularity: "DAILY",
      instanceId: "inst-1",
      processingDate: "2026-08-30",
      report,
      type: "asc_fetch_instance",
    });
    const row = await env.DB.prepare(
      "SELECT r2_key, checksum, anomaly FROM asc_report_instance"
    ).first<{ r2_key: string; checksum: string; anomaly: string | null }>();
    expect(row?.checksum).toBe("abc");
    expect(row?.anomaly).toBeNull();
    // The report name is slugged into a safe key.
    expect(row?.r2_key).toContain(
      `asc/${APP_ID}/App_Store_Discovery_and_Engagement/DAILY/`
    );
    await expect(env.ARCHIVE.get(row?.r2_key ?? "")).resolves.not.toBeNull();
  });

  it("flags Apple's duplicate-processingDate defect", async () => {
    await env.DB.prepare(
      "INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (?1, ?2, 'DAILY', '2026-08-30', 'inst-1', 0)"
    )
      .bind(APP_ID, report.name)
      .run();
    stubFetch((url) =>
      url.includes("presigned")
        ? new Response("gz")
        : Response.json({
            data: [
              {
                attributes: {
                  checksum: "def",
                  sizeInBytes: 5,
                  url: "https://presigned.example/2.gz",
                },
                id: "seg-2",
              },
            ],
          })
    );
    await ascFetchInstanceStep(ascEnv(), {
      appId: String(APP_ID),
      granularity: "DAILY",
      instanceId: "inst-2",
      processingDate: "2026-08-30",
      report,
      type: "asc_fetch_instance",
    });
    const row = await env.DB.prepare(
      "SELECT anomaly FROM asc_report_instance WHERE instance_id = 'inst-2'"
    ).first<{ anomaly: string }>();
    expect(row?.anomaly).toBe("duplicate_date");
    const err = await env.DB.prepare(
      "SELECT error_class FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string }>();
    expect(err?.error_class).toBe("duplicate_processing_date");
  });

  it("does not call a second app's report a duplicate of the first's", async () => {
    // Two apps publishing the same report type on the same date is the normal
    // case, not Apple's duplicate-processingDate defect.
    await env.DB.prepare(
      "INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (?1, ?2, 'DAILY', '2026-08-30', 'inst-1', 0)"
    )
      .bind(OTHER_APP_ID, report.name)
      .run();
    stubFetch((url) =>
      url.includes("presigned")
        ? new Response("gz")
        : Response.json({
            data: [
              {
                attributes: {
                  checksum: "ghi",
                  sizeInBytes: 5,
                  url: "https://presigned.example/3.gz",
                },
                id: "seg-3",
              },
            ],
          })
    );
    await ascFetchInstanceStep(ascEnv(), {
      appId: String(APP_ID),
      granularity: "DAILY",
      instanceId: "inst-9",
      processingDate: "2026-08-30",
      report,
      type: "asc_fetch_instance",
    });
    const row = await env.DB.prepare(
      "SELECT anomaly FROM asc_report_instance WHERE instance_id = 'inst-9'"
    ).first<{ anomaly: string | null }>();
    expect(row?.anomaly).toBeNull();
  });
});

describe(ascDetectSkippedDates, () => {
  it("reports a date Apple never published between two ingested days", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-28', 'i1', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-30', 'i2', 0)`
      ),
    ]);
    await ascDetectSkippedDates(env);
    const err = await env.DB.prepare(
      "SELECT error_class, params FROM fetch_error ORDER BY id DESC LIMIT 1"
    ).first<{ error_class: string; params: string }>();
    expect(err?.error_class).toBe("skipped_processing_date");
    expect(err?.params).toContain("2026-08-29");
  });

  // The app dimension is what makes both of these answerable. With it
  // collapsed, one app's published day satisfied every other app's gap check
  // and no skipped date was ever reported for a second tracked app.
  it("keeps one app's published day out of another app's gap check", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-28', 'a1', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-30', 'a2', 0)`
      ),
      // A second app that did publish the 29th. It must not cover the first
      // app's missing day.
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${OTHER_APP_ID}, 'R', 'DAILY', '2026-08-29', 'b1', 0)`
      ),
    ]);
    await ascDetectSkippedDates(env);
    const err = await env.DB.prepare(
      "SELECT params FROM fetch_error WHERE error_class = 'skipped_processing_date'"
    ).all<{ params: string }>();
    expect(err.results.map((e) => e.params)).toStrictEqual([
      `${APP_ID} R 2026-08-29`,
    ]);
  });

  it("stays quiet on a contiguous run of days", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-28', 'i1', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-29', 'i2', 0)`
      ),
    ]);
    await ascDetectSkippedDates(env);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM fetch_error"
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
