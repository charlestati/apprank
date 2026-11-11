# How much can you track?

The unit is the **crawl pair**: one keyword in one storefront. 20 keywords
across 5 storefronts is 100 pairs, and pairs are what every limit below counts.

## What binds is the fetch rate, not Cloudflare

Collection runs from a GitHub Actions job at a fixed spacing, set in
`scripts/local-refresh/refresh.sh`, not at the rate the collector learns. Apple
documents the Search API at "approximately 20 calls per minute (subject to
change)" and answers a breach with **403**, not 429. A keyword crawl is spaced
3.75 seconds apart and costs about 10 seconds with Apple's round-trip on top; a
queued task step (a lookup, a reviews page, a chart) is spaced 10 seconds apart
and costs about 13.

| Budget                                                   | Minutes |
| -------------------------------------------------------- | ------- |
| The job's timeout                                        | 210     |
| Crawls, capped at 500 by `APPRANK_REFRESH_MAX_UNITS`     | ~83     |
| Task steps, capped at 80 by `APPRANK_REFRESH_MAX_STEPS`  | ~17     |
| Setup, warm-up, the daily fan-out and the post-run check | ~10     |

So the run window does not bind; the unit ceiling does, and it has to stay above
your pair count or the lowest-weighted storefront is starved every run rather
than sharing the shortfall. Raise it and the window absorbs a good deal more.
Those figures are the clean case. Every stalled request adds a 60-second pause,
and the slowest of this deployment's forty daily runs to 2026-11-11 took 136
minutes against a median of 67, so leave the timeout its headroom.

Keep a margin rather than matching the pair count exactly: a request that stalls
spends an iteration of the ceiling without crawling anything, and the remote D1
and R2 bindings stall a couple of dozen times in a normal cycle.

The other cap is the _learned_ rate, which the job does not fetch at but which
sizes the cadence plan: how many pairs are scheduled daily and how many on a
slower rung. It halves after a throttled day and floors at 1/min. At the floor
the same set is re-spaced across slower rungs until it recovers, 10% a day. That
is a feature on a shared egress IP, where reputation binds harder than the
published number: developers report 403s at 4 calls a minute from
poor-reputation addresses and clean runs at 20 from good ones.

Beyond the budget nothing breaks: the ladder re-spaces pairs across 1, 2, 3 and
7-day rungs so the daily load still fits, and a few hundred more stay trackable
at lower resolution. Adding keywords costs frequency on the least informative
pairs, never coverage, because a dropped pair loses its history permanently.

## Cloudflare's free tier is not what runs out

| Resource         | Free tier     | What this uses                                                                                                                                                 |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 row-writes    | 100,000/day   | ~21 per pair on a cold crawl, far less in steady state. About 4,700 crawls a day before it binds                                                               |
| D1 rows read     | 5,000,000/day | The "latest rank per pair" lookups read at most 90 days per tracked pair, whatever the history; the report and history reads scale with the window you ask for |
| R2 storage       | 10 GB         | NDJSON, one file per storefront per month                                                                                                                      |
| Workers requests | 100,000/day   | Asset requests included, since the Worker gates the whole origin                                                                                               |

That 21 is a **cold** crawl, where every app and metadata row is new: 50 pairs
produced 50 `ranking`, 512 `rank_entry`, 225 `app` and 270
`app_metadata_version` rows. Steady state is far cheaper, since `rank_entry` is
rewritten only when the page moved and the upserts skip unchanged rows.

## Private repositories have a second ceiling

GitHub gives free accounts **2,000 Actions minutes a month** on private
repositories, and **unlimited** minutes on public ones.

| Daily run                                                  | Minutes/month |
| ---------------------------------------------------------- | ------------- |
| 100 pairs, estimated from the unit costs above: 40 minutes | ~1,200        |
| Median observed here over forty runs, 67 minutes           | ~2,000        |
| Slowest observed here, 136 minutes                         | ~4,100        |
| A full 210-minute window                                   | ~6,300        |

Only the first fits inside 2,000 with room to spare. A tracked set of a few
hundred pairs needs a public repository, where minutes are unlimited. Public
repositories have their own catch: GitHub disables a scheduled workflow after 60
days without repository activity, which [deploying](deploy.md) covers.

## Practical shapes

| Setup                                   | Pairs | Resolution                              |
| --------------------------------------- | ----- | --------------------------------------- |
| 1 app, 20 keywords, 5 storefronts       | 100   | All daily                               |
| 1 app, 130 keywords, 3 storefronts      | 390   | All daily                               |
| 2 apps, 80 keywords each, 3 storefronts | 480   | All daily, with the unit ceiling raised |
| 1 app, 200 keywords, 5 storefronts      | 1,000 | Much of it weekly                       |

The 480-pair row sits twenty under the default ceiling of 500, which is less
than the couple of dozen stalls a normal cycle spends, so raise
`APPRANK_REFRESH_MAX_UNITS` before tracking that many.

The data-health page shows the plan the collector actually chose ("340 pairs
every 1d, 260 every 2d"), which is the real answer for your set.
