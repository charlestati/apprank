import { describe, expect, it } from "vitest";

import {
	formatDay,
	formatDecimal,
	formatNumber,
	regionFlag,
	regionName,
} from "../src/format";

describe(regionName, () => {
	it("names a storefront in the chosen language", () => {
		expect(regionName("be", "en")).toBe("Belgium");
		expect(regionName("be", "fr")).toBe("Belgique");
		// Lowercase in the database, uppercase for Intl.
		expect(regionName("ch", "fr")).toBe("Suisse");
	});

	it("keeps the reference name for a code Intl cannot resolve", () => {
		// Apple ships the odd storefront that is not an ISO region. Intl echoes
		// the code straight back for those, which is the signal to prefer the name
		// the reference data carries.
		expect(regionName("qq", "fr", "Somewhere")).toBe("Somewhere");
	});

	it("falls back to the code when there is no reference name either", () => {
		expect(regionName("qq", "en")).toBe("QQ");
	});
});

describe(regionFlag, () => {
	it("maps an ISO code onto its regional-indicator pair", () => {
		expect(regionFlag("fr")).toBe("\u{1F1EB}\u{1F1F7}");
		expect(regionFlag("US")).toBe("\u{1F1FA}\u{1F1F8}");
	});

	it("emits nothing for a storefront that is not a region", () => {
		// The indicators for an unassigned pair draw as two boxed capitals, so
		// the tag shows the name alone rather than a flag-shaped mistake.
		expect(regionFlag("qq")).toBe("");
		expect(regionFlag("")).toBe("");
	});
});

describe(formatNumber, () => {
	it("groups thousands the way each language does", () => {
		expect(formatNumber(1234, "en")).toBe("1,234");
		// French groups with a narrow no-break space, so compare on whitespace
		// rather than pinning the exact code point ICU happens to pick.
		expect(formatNumber(1234, "fr").replaceAll(/\s/gu, " ")).toBe("1 234");
	});
});

describe(formatDecimal, () => {
	it("uses the right decimal separator", () => {
		expect(formatDecimal(4, "en", 1)).toBe("4.0");
		expect(formatDecimal(4, "fr", 1)).toBe("4,0");
	});
});

describe(formatDay, () => {
	it("names the month, so the day is never ambiguous", () => {
		// 09/02 and 02/09 are the same date written two ways; "2 Sep" is not.
		expect(formatDay("2026-08-30", "en")).toBe("30 Aug 2026");
		expect(formatDay("2026-08-30", "fr")).toContain("août");
	});

	it("reads the day in UTC, like every observed_date", () => {
		// Parsed as local time this lands on the 29th west of Greenwich, which
		// would print a rank on the wrong day for half the world.
		expect(formatDay("2026-08-30", "en")).toContain("30");
	});

	it("passes through anything that is not a date", () => {
		expect(formatDay("not-a-date", "en")).toBe("not-a-date");
	});
});
