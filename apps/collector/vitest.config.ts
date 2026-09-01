import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "../../packages/core/migrations")
  );
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Dummy secrets so steps can be exercised against mocked fetch.
            ASC_ISSUER_ID: "",
            ASC_KEY_ID: "",
            ASC_PRIVATE_KEY: "",
            ADS_CLIENT_ID: "",
            ADS_TEAM_ID: "",
            ADS_KEY_ID: "",
            ADS_PRIVATE_KEY: "",
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    test: {
      coverage: {
        // v8 coverage is unavailable inside workerd; istanbul instruments the
        // source at transform time and works in the Workers pool.
        provider: "istanbul",
        include: ["src/**/*.ts", "../../packages/core/src/**/*.ts"],
        exclude: ["src/env.ts", "**/*.d.ts"],
        reporter: ["text-summary", "json-summary"],
        thresholds: { branches: 70, functions: 80, lines: 80, statements: 80 },
      },
      setupFiles: ["./test/setup.ts"],
    },
  };
});
