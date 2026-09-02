# How much can you track?

The unit is the **crawl pair**: one keyword in one storefront. 20 keywords
across 5 storefronts is 100 pairs, and pairs are what every limit below counts.

## The binding constraint is the collection window, not Cloudflare

Collection runs from a GitHub Actions job, at the rate the collector has learned
it can fetch without being throttled. The job's `timeout-minutes` is the real
ceiling: one unit is one keyword crawl or one queued task step, and each costs
about 21 seconds, the 15-second spacing plus the round-trip on top of it.

| Budget                                                           | Units    |
| ---------------------------------------------------------------- | -------- |
| One 210-minute run                                               | ~600     |
| Less checkout, install, warm-up and the post-run verify          | ~30      |
| Less the daily task steps (compaction, lookups, reviews, charts) | ~40      |
| **Pair crawls per run**                                          | **~530** |

Two things cap it below that. `APPRANK_REFRESH_MAX_UNITS` in
`scripts/local-refresh/refresh.sh` stops the crawl loop at 420, and it has to
stay above your pair count or the lowest-weighted storefront is starved every
run rather than sharing the shortfall. And the cadence planner budgets against
the _learned_ rate, which falls to 1/min after a throttled day; at that rate the
same set is re-spaced across slower rungs until the rate recovers.

Beyond the budget nothing breaks: the ladder re-spaces pairs across 1, 2, 3 and
7-day rungs so the daily load still fits, and a few hundred more stay trackable
at lower resolution. Adding keywords costs frequency on the least informative
pairs, never coverage, because a dropped pair loses its history permanently.

## Cloudflare's free tier is not what runs out

| Resource         | Free tier     | What this uses                                                                                   |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| D1 row-writes    | 100,000/day   | ~21 per pair on a cold crawl, far less in steady state. About 4,700 crawls a day before it binds |
| D1 rows read     | 5,000,000/day | The dashboard's queries are bounded to 90 days precisely so this stays flat as history grows     |
| R2 storage       | 10 GB         | NDJSON, one file per storefront per month                                                        |
| Workers requests | 100,000/day   | Asset requests included, since the Worker gates the whole origin                                 |

That 21 is a **cold** crawl, where every app and metadata row is new: 50 pairs
produced 50 `ranking`, 512 `rank_entry`, 225 `app` and 270
`app_metadata_version` rows. Steady state is far cheaper, since `rank_entry` is
rewritten only when the page moved and the upserts skip unchanged rows.

## Private repositories have a second ceiling

GitHub gives free accounts **2,000 Actions minutes a month** on private
repositories, and **unlimited** minutes on public ones.

| Daily run                       | Minutes/month |
| ------------------------------- | ------------- |
| Median observed here, 8 minutes | ~240          |
| Slowest observed, 26 minutes    | ~780          |
| A full 210-minute window        | ~6,300        |

Only the first two fit inside 2,000. A tracked set large enough to fill the
window needs a public repository, where minutes are unlimited.

## Practical shapes

| Setup                                   | Pairs | Resolution        |
| --------------------------------------- | ----- | ----------------- |
| 1 app, 20 keywords, 5 storefronts       | 100   | All daily         |
| 1 app, 130 keywords, 3 storefronts      | 390   | All daily         |
| 2 apps, 80 keywords each, 3 storefronts | 480   | All daily         |
| 1 app, 200 keywords, 5 storefronts      | 1,000 | Much of it weekly |

The data-health page shows the plan the collector actually chose ("340 pairs
every 1d, 260 every 2d"), which is the real answer for your set.
