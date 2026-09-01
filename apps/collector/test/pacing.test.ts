/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import {
  loadPacing,
  savePacing,
  tickMs,
  onThrottle,
  onAdminThrottle,
  maybeRaise,
} from "../src/lib/pacing";

function defaultPacing() {
  return {
    lastErrorAt: 0,
    lastRollDay: "",
    pauseUntil: 0,
    ratePerMin: 4,
    throttlesPrevDay: 0,
    windowErrorCount: 0,
  };
}

/** Advance past the pause a throttle just imposed, as the work loop does. */
function afterPause(p: { pauseUntil: number }) {
  return p.pauseUntil + 1000;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM collector_state").run();
});

describe("pacing state", () => {
  it("starts conservative when nothing is persisted", async () => {
    const p = await loadPacing(env.DB);
    expect(p.ratePerMin).toBe(4);
    expect(p.pauseUntil).toBe(0);
    expect(p.windowErrorCount).toBe(0);
  });

  it("round-trips through D1 so a redeploy keeps the learned rate", async () => {
    const p = await loadPacing(env.DB);
    await savePacing(env.DB, { ...p, ratePerMin: 5.5 });
    const again = await loadPacing(env.DB);
    expect(again.ratePerMin).toBe(5.5);
  });
});

describe(tickMs, () => {
  it("spaces fetches around the learned rate with jitter", () => {
    const p = { ...defaultPacing(), ratePerMin: 4 };
    const samples = Array.from({ length: 50 }, () => tickMs(p));
    // 4/min = 15s base, ±25% jitter.
    for (const ms of samples) {
      expect(ms).toBeGreaterThanOrEqual(11_250);
      expect(ms).toBeLessThanOrEqual(18_750);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it("slows down proportionally when the rate drops", () => {
    const slow = tickMs({ ...defaultPacing(), ratePerMin: 1 });
    expect(slow).toBeGreaterThan(40_000);
  });
});

describe(onThrottle, () => {
  it("pauses on the first hit but leaves the rate alone", () => {
    const now = 1_000_000;
    const p = onThrottle(defaultPacing(), now);
    // One stray 429 on a shared egress IP is background noise, not a signal to
    // give up half the day's budget.
    expect(p.ratePerMin).toBe(4);
    expect(p.windowErrorCount).toBe(1);
    expect(p.lastErrorAt).toBe(now);
    // 30 min base ±25%.
    const pauseMinutes = (p.pauseUntil - now) / 60_000;
    expect(pauseMinutes).toBeGreaterThan(20);
    expect(pauseMinutes).toBeLessThan(40);
  });

  it("backs off exponentially across consecutive hits, capped at 4h", () => {
    let now = 1_000_000;
    let p = defaultPacing();
    const pauses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      p = onThrottle(p, now);
      pauses.push((p.pauseUntil - now) / 60_000);
      now = afterPause(p);
    }
    expect(pauses[1]).toBeGreaterThan(pauses[0] as number);
    expect(pauses[2]).toBeGreaterThan(pauses[1] as number);
    // Capped: 30 · 2^4 = 480 would exceed the 240-minute ceiling (+jitter).
    expect(pauses.at(-1)).toBeLessThan(240 * 1.3);
  });

  it("halves the rate once a day's hits pass the tolerance", () => {
    let now = 1_000_000;
    let p = defaultPacing();
    for (let i = 0; i < 4; i += 1) {
      p = onThrottle(p, now);
      now = afterPause(p);
    }
    // Four hits is the tolerance: still holding.
    expect(p.ratePerMin).toBe(4);
    p = onThrottle(p, now);
    expect(p.ratePerMin).toBe(2);
  });

  it("halves once per day, not once per throttle", () => {
    // Applying the halve on every hit past tolerance turned the rate back into
    // a one-way ratchet — 4 → 2 → 1 in three throttles — which is the failure
    // the pause/rate split exists to prevent.
    let now = 1_000_000;
    let p = defaultPacing();
    for (let i = 0; i < 7; i += 1) {
      p = onThrottle(p, now);
      now = afterPause(p);
    }
    expect(p.windowErrorCount).toBe(7);
    expect(p.ratePerMin).toBe(2);
  });

  it("counts a throttle that arrives mid-pause without compounding it", () => {
    const now = 1_000_000;
    const first = onThrottle(defaultPacing(), now);
    // An admin-triggered crawl ignores the pause; the loop itself never does.
    const during = onThrottle(first, now + 60_000);
    expect(during.windowErrorCount).toBe(2);
    expect(during.pauseUntil).toBe(first.pauseUntil);
    expect(during.ratePerMin).toBe(first.ratePerMin);
  });

  it("never drops the rate below the 1/min floor", () => {
    // The floor is reached across days, not within one: a bad day costs a
    // single halving, so it takes three consecutive bad days to fall 4 → 1 and
    // any number after that to stay there.
    let now = 1_000_000;
    let p = defaultPacing();
    for (let day = 0; day < 6; day += 1) {
      for (let i = 0; i < 5; i += 1) {
        p = onThrottle(p, now);
        now = afterPause(p);
      }
      p = maybeRaise(p, `2026-09-0${day + 1}`);
    }
    expect(p.ratePerMin).toBe(1);
  });
});

describe(onAdminThrottle, () => {
  it("records the hit but leaves the loop's rate, pause and tally alone", () => {
    const now = 2_000_000;
    const before = { ...defaultPacing(), ratePerMin: 4.4, windowErrorCount: 1 };
    const after = onAdminThrottle(before, now);
    expect(after.lastErrorAt).toBe(now);
    expect(after.ratePerMin).toBe(4.4);
    expect(after.pauseUntil).toBe(before.pauseUntil);
    expect(after.windowErrorCount).toBe(1);
  });

  it("cannot push the day past tolerance however often it is called", () => {
    // A diagnostic must not change the thing it measures: probing ten times
    // used to inflate the tally and halve the next day's rate.
    let p = { ...defaultPacing(), ratePerMin: 4.4 };
    for (let i = 0; i < 10; i += 1) {
      p = onAdminThrottle(p, 2_000_000 + i);
    }
    expect(p.windowErrorCount).toBe(0);
    expect(maybeRaise(p, "2026-09-02").ratePerMin).toBeCloseTo(4.84, 5);
  });
});

describe(maybeRaise, () => {
  const day = "2026-09-01";

  it("raises by 10% after a day with no throttling", () => {
    const p = maybeRaise({ ...defaultPacing(), lastErrorAt: 0 }, day);
    expect(p.ratePerMin).toBeCloseTo(4.4, 5);
    expect(p.lastRollDay).toBe(day);
  });

  it("still raises after a day that stayed within tolerance", () => {
    // The ratchet bug: this IP throttles most days, so requiring a clean 24h
    // meant the rate only ever fell.
    const p = maybeRaise(
      { ...defaultPacing(), lastErrorAt: Date.now(), windowErrorCount: 4 },
      day
    );
    expect(p.ratePerMin).toBeCloseTo(4.4, 5);
    expect(p.throttlesPrevDay).toBe(4);
    expect(p.windowErrorCount).toBe(0);
  });

  it("holds the rate after a day that broke the tolerance", () => {
    const p = maybeRaise({ ...defaultPacing(), windowErrorCount: 5 }, day);
    expect(p.ratePerMin).toBe(4);
    expect(p.throttlesPrevDay).toBe(5);
    expect(p.windowErrorCount).toBe(0);
  });

  it("rolls at most once per day, so a second call cannot re-raise", () => {
    const first = maybeRaise(defaultPacing(), day);
    const second = maybeRaise(first, day);
    expect(second.ratePerMin).toBe(first.ratePerMin);
    expect(second.throttlesPrevDay).toBe(first.throttlesPrevDay);
  });

  it("recovers from the floor instead of staying pinned there", () => {
    let p = { ...defaultPacing(), ratePerMin: 1 };
    for (let i = 0; i < 30; i += 1) {
      p = maybeRaise({ ...p, lastRollDay: "" }, day);
    }
    expect(p.ratePerMin).toBe(6);
  });

  it("stops raising at the 6/min ceiling", () => {
    let p = { ...defaultPacing(), ratePerMin: 5.9 };
    for (let i = 0; i < 5; i += 1) {
      p = maybeRaise({ ...p, lastRollDay: "" }, day);
    }
    expect(p.ratePerMin).toBe(6);
  });
});
