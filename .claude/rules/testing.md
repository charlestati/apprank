---
paths:
  - "**/test/**"
  - "**/*.test.*"
---

# Tests

- `@cloudflare/vitest-pool-workers` 0.20 has **no isolated storage** and **no
  `fetchMock`**. Reset the database in `beforeEach` (see
  `apps/web/test/fixtures.ts`) and stub `globalThis.fetch` via `vi.stubGlobal`
  (see `apps/collector/test/helpers.ts`). Tests share the isolate with the
  Worker, so a global stub intercepts its outbound calls.
- Inspect Durable Object state with `runInDurableObject` rather than widening
  the production RPC surface for tests.
- A Durable Object receives the Worker's **deployed** env, not the per-call
  overrides handed to `worker.fetch(request, { ...env, SECRET: x })`. A job that
  runs inside `SchedulerDO` therefore cannot be given a synthetic Apple key from
  a test; assert the failure path instead (see `test/admin.test.ts`).
- Never point synthetic data at the remote database. Seed the local D1, review,
  then clear it.
- **An MCP reply is produced lazily as its SSE stream is read.** A test that
  calls the endpoint and asserts on a `waitUntil` side effect, the audit row,
  without draining the body first waits for nothing, because the tool has not
  run yet. `test/mcp-fixtures.ts` reads the body _before_
  `waitOnExecutionContext`; do not reorder it.
