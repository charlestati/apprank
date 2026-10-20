import type { Env as CollectorEnv } from "../src/env";

// The plugin types `env` from cloudflare:test as Cloudflare.Env, which
// `wrangler types` fills from wrangler.jsonc alone and so leaves out every
// secret. The tests pass that env where the source expects its own Env.
declare global {
	namespace Cloudflare {
		interface Env extends CollectorEnv {
			TEST_MIGRATIONS: { name: string; queries: string[] }[];
		}
	}
}
