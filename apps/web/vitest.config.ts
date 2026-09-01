import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects: the JSON API runs in the Workers runtime (real D1/R2
// bindings), the SPA runs in happy-dom. Coverage is merged across both.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "../../packages/core/migrations")
  );
  return {
    test: {
      coverage: {
        provider: "istanbul",
        include: ["src/**/*.ts", "client/src/**/*.ts", "client/src/**/*.tsx"],
        exclude: ["src/env.ts", "client/src/main.tsx", "**/*.d.ts"],
        reporter: ["text-summary", "json-summary"],
        thresholds: { branches: 70, functions: 80, lines: 80, statements: 80 },
      },
      projects: [
        {
          plugins: [
            cloudflareTest({
              miniflare: {
                bindings: {
                  // The API fails closed without an auth secret; the tests
                  // that exercise the gate override this per request.
                  ALLOW_UNAUTHENTICATED: "true",
                  TEST_MIGRATIONS: migrations,
                },
              },
              wrangler: { configPath: "./wrangler.jsonc" },
            }),
          ],
          test: {
            name: "api",
            include: ["test/**/*.test.ts"],
            setupFiles: ["./test/setup.ts"],
          },
        },
        {
          plugins: [react()],
          test: {
            name: "client",
            environment: "happy-dom",
            include: ["client/test/**/*.test.tsx"],
            setupFiles: ["./client/test/setup.ts"],
          },
        },
      ],
    },
  };
});
