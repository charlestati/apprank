import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../src/api";
import { APP_ID, stubFetch, trackedApp } from "./harness";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests each endpoint under /api", async () => {
    const calls = stubFetch({ "*": [] });
    await Promise.all([
      api.apps(),
      api.health(),
      api.keywords(APP_ID),
      api.reviews(APP_ID),
      api.suggestions(),
    ]);
    expect(calls).toStrictEqual([
      "/api/apps",
      "/api/health/data",
      `/api/apps/${APP_ID}/keywords`,
      `/api/apps/${APP_ID}/reviews`,
      "/api/suggestions",
    ]);
  });

  it("defaults the history and competitor windows", async () => {
    const calls = stubFetch({ "*": [] });
    await api.history(7, APP_ID);
    await api.competitors(7);
    expect(calls).toStrictEqual([
      `/api/pairs/7/history?appId=${APP_ID}&days=90`,
      "/api/pairs/7/competitors?days=30",
    ]);
  });

  it("passes an explicit window through", async () => {
    const calls = stubFetch({ "*": [] });
    await api.history(7, APP_ID, 14);
    await api.competitors(7, 120);
    expect(calls).toStrictEqual([
      `/api/pairs/7/history?appId=${APP_ID}&days=14`,
      "/api/pairs/7/competitors?days=120",
    ]);
  });

  it("parses the JSON body", async () => {
    stubFetch({ "/api/apps": [trackedApp] });
    await expect(api.apps()).resolves.toStrictEqual([trackedApp]);
  });

  it("throws with the status and path when the response is not ok", async () => {
    stubFetch({ "/api/apps": new Response("boom", { status: 500 }) });
    await expect(api.apps()).rejects.toThrow("500 /apps");
  });

  it("throws on an unauthorised response", async () => {
    stubFetch({ "/api/suggestions": new Response("", { status: 401 }) });
    await expect(api.suggestions()).rejects.toThrow("401 /suggestions");
  });
});
