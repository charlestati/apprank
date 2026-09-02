import { describe, it, expect } from "vitest";

import type { Env } from "../src/env";
import {
	collectionMode,
	collectsPublicEndpoints,
	dropsTask,
} from "../src/lib/mode";

const asEnv = (mode?: string) => ({ COLLECTION_MODE: mode }) as Env;

describe(collectionMode, () => {
	it("defaults to collecting everything", () => {
		expect(collectionMode(asEnv())).toBe("all");
		expect(collectsPublicEndpoints(asEnv())).toBeTruthy();
	});

	it("recognises only the exact credentialed value", () => {
		expect(collectionMode(asEnv("credentialed"))).toBe("credentialed");
		expect(collectionMode(asEnv("Credentialed"))).toBe("all");
	});
});

describe(dropsTask, () => {
	const credentialed = asEnv("credentialed");

	it("drops queued iTunes work the deployment cannot fetch", () => {
		for (const type of ["chart_pull", "lookup_pull", "review_pull"]) {
			expect(dropsTask(credentialed, type, "loop")).toBeTruthy();
		}
	});

	it("keeps the credentialed tasks, which reach Apple over other infrastructure", () => {
		for (const type of [
			"asc_poll",
			"asc_fetch_instance",
			"ads_pull",
			"compact",
		]) {
			expect(dropsTask(credentialed, type, "loop")).toBeFalsy();
		}
	});

	it("exempts the admin path, which exists to test whether Apple still refuses", () => {
		expect(dropsTask(credentialed, "chart_pull", "admin")).toBeFalsy();
	});

	it("drops nothing where the public endpoints are reachable", () => {
		expect(dropsTask(asEnv(), "chart_pull", "loop")).toBeFalsy();
	});
});
