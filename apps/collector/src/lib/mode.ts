// Which endpoints this deployment is allowed to reach.
//
// Apple rate-limits the public iTunes endpoints per IP, and every Cloudflare
// Worker egresses from a shared pool Apple already rejects. The deployed
// collector therefore cannot crawl ranks, look up metadata, or pull reviews
// and charts, because it gets 429 on every attempt. Those attempts were not
// free: each one feeds `windowErrorCount`, which is what halves the learned
// rate, so a known-broken path was steadily corrupting the signal that decides
// how often every pair gets checked.
//
// App Store Connect and Apple Ads are credentialed, quota'd per account and
// reached over different infrastructure. They work from Cloudflare, and the
// state they have written proves it.
//
// So the deployment runs `credentialed` and the borrowed-IP runner (see
// scripts/local-refresh) runs `all`. Manual triggers are deliberately exempt:
// `crawlNow` still fetches whatever it is asked to, which is what makes
// "is Apple still blocking this IP?" a question you can answer in one request.

import type { Env } from "../env";

export type CollectionMode = "all" | "credentialed";

export function collectionMode(env: Env): CollectionMode {
	return env.COLLECTION_MODE === "credentialed" ? "credentialed" : "all";
}

/** Whether this deployment may reach Apple's public, IP-rate-limited endpoints. */
export function collectsPublicEndpoints(env: Env): boolean {
	return collectionMode(env) === "all";
}

/** Task types that reach the public, IP-rate-limited iTunes endpoints. */
const PUBLIC_ENDPOINT_TASKS = new Set([
	"chart_pull",
	"lookup_pull",
	"review_pull",
]);

/**
 * Whether the paced loop must discard this task instead of running it.
 *
 * A queue outlives the config that filled it. Tasks enqueued while a
 * deployment still collected everything keep draining after it is switched to
 * `credentialed`, one 429 per tick, and each hit pauses the loop and counts
 * towards the daily tally that halves the learned rate -- the rate the cadence
 * planner then budgets the *runner's* whole day against. Dropping them is safe:
 * the daily fan-out no longer produces them, and the runner enqueues its own
 * into its own Durable Object.
 *
 * The admin path stays exempt, as `runNow` documents: asking this deployment to
 * try an endpoint is how you find out whether Apple still refuses it.
 */
export function dropsTask(
	env: Env,
	type: string,
	source: "loop" | "admin"
): boolean {
	return (
		source === "loop" &&
		PUBLIC_ENDPOINT_TASKS.has(type) &&
		!collectsPublicEndpoints(env)
	);
}
