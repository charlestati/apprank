// Which endpoints this deployment is allowed to reach.
//
// Apple rate-limits the public iTunes endpoints per IP, and every Cloudflare
// Worker egresses from a shared pool Apple already rejects. The deployed
// collector therefore cannot crawl ranks, look up metadata, or pull reviews and
// charts — it gets 429 on every attempt. Those attempts were not free: each one
// feeds `windowErrorCount`, which is what halves the learned rate, so a
// known-broken path was steadily corrupting the signal that decides how often
// every pair gets checked.
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
