# Roadmap

Open work for AppRank. Done work leaves this file; git keeps it.

## Repository

- [ ] Close Dependabot PRs #13 to #18 once the dependency refresh is on `main`;
      it ships every version they propose, or a newer one.
- [ ] Move to Node 26 once it enters LTS (scheduled for 2026-10-28): bump
      `.node-version`, `engines` and `@types/node`, then run `pnpm run ci`.
- [ ] Re-check GHSA-vfj7-8cjw-p6xm (`braces`, reached through `ultracite`) by
      2027-01-20, and drop its `audit.ignore` entry once a patched release or an
      `ultracite` without it exists.
- [ ] Drop the `@esbuild-kit/core-utils>esbuild` override once `drizzle-kit`
      stops depending on the deprecated `@esbuild-kit` loader.

## Archive and rebuild

Owner: [architecture](docs/architecture.md).

- [ ] Teach `scripts/rebuild-d1` to rebuild metadata, reviews, ratings and
      charts from R2, so invariant 2 holds for every table and not only rankings
      and popularity.
