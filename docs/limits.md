# How much can you track?

The unit is the **crawl pair**: one (keyword, storefront, locale) triple. Ten
keywords in five storefronts is fifty pairs, not ten, and fifty is the number
every limit below applies to.

## The binding constraint is the collection window, not Cloudflare

Collection runs from a GitHub Actions job with a 45-minute timeout, at the rate
the collector has learned it can fetch without being throttled. Measured on a
real run: **2.6 units a minute**, where a unit is one keyword crawl or one
queued task step. The learned rate moves between 1 and 6 fetches a minute, so
treat 2.6 as the middle of the range rather than a constant.

|                                                                  |          |
| ---------------------------------------------------------------- | -------- |
| Units in one 45-minute run                                       | ~115     |
| Less the daily task steps (compaction, lookups, reviews, charts) | ~15      |
| **Pair crawls per run**                                          | **~100** |

So roughly **100 pairs at daily resolution**: 20 keywords across 5 storefronts,
or 50 keywords in 2.

Beyond that the cadence ladder takes over rather than anything breaking. Pairs
are re-spaced across 1, 2, 3 and 7-day rungs so the daily load still fits, which
means a few hundred pairs are trackable at lower resolution. Adding keywords
costs _frequency on the least informative pairs_, never coverage. A dropped pair
would lose its history permanently, so the collector never drops one.

## Cloudflare's free tier is not what runs out

| Resource         | Free tier     | What this uses                                                                                   |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| D1 row-writes    | 100,000/day   | ~21 per pair on a cold crawl, far less in steady state. About 4,700 crawls a day before it binds |
| D1 rows read     | 5,000,000/day | The dashboard's queries are bounded to 90 days precisely so this stays flat as history grows     |
| R2 storage       | 10 GB         | NDJSON, one file per storefront per month                                                        |
| Workers requests | 100,000/day   | Asset requests included, since the Worker gates the whole origin                                 |

The 21 writes per pair is measured on a **cold** crawl, where every app and
every metadata row is new: 50 pairs produced 50 `ranking` rows, 512 `rank_entry`
rows, 225 `app` rows and 270 `app_metadata_version` rows. In steady state most
of that disappears. `rank_entry` is only rewritten when the indexed page
actually moved, and the app and metadata upserts carry guards that skip an
unchanged row.

## Private repositories have a second ceiling

GitHub gives free accounts **2,000 Actions minutes a month** on private
repositories, and **unlimited** minutes on public ones.

|                                       | Minutes/month |
| ------------------------------------- | ------------- |
| Observed run today (26 min × 30 days) | ~780          |
| A run using the full 45-minute window | ~1,350        |

Both fit inside 2,000, but the second leaves little room for manual runs or
retries. If you expect to fill the window daily, make the repository public or
budget for the minutes.

## Practical shapes

| Setup                                   | Pairs | Fits in one daily run?     |
| --------------------------------------- | ----- | -------------------------- |
| 1 app, 20 keywords, 5 storefronts       | 100   | Yes, everything daily      |
| 1 app, 40 keywords, 5 storefronts       | 200   | Yes, on 1–2 day rungs      |
| 2 apps, 30 keywords each, 3 storefronts | 180   | Yes, on 1–2 day rungs      |
| 1 app, 100 keywords, 5 storefronts      | 500   | Yes, but much of it weekly |

The data-health page shows the plan the collector actually chose ("340 pairs
every 1d, 260 every 2d"), which is the real answer for your set.
