// Locale-aware display, driven by the language the operator picked rather than
// the browser's own. The two disagree routinely — a French speaker on an en-US
// machine chooses Français here — and `toLocaleDateString()` with no argument
// silently follows the machine, so a French page ends up mixing "1,234" with
// "1 234" and reads as a bug.
//
// Every formatter is cached per language. Constructing an Intl object is the
// expensive part, and these run once per row of a dense table.

import { useMemo } from "react";

import type { Lang } from "./i18n";
import { useI18n } from "./i18n";

/**
 * en-GB rather than en, because a bare "en" resolves to US conventions and
 * would print 09/02/2026 for a date every European storefront reads as
 * 2 September. Dates below avoid the ambiguity outright by naming the month,
 * but the region still decides grouping and time format.
 */
const LOCALES: Record<Lang, string> = { en: "en-GB", fr: "fr-FR" };

const regions = new Map<Lang, Intl.DisplayNames>();
const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();

function cached<T>(store: Map<string, T>, key: string, make: () => T): T {
	const hit = store.get(key);
	if (hit) {
		return hit;
	}
	const made = make();
	store.set(key, made);
	return made;
}

function dayFormatter(lang: Lang): Intl.DateTimeFormat {
	return cached(
		dates,
		`${lang}:day`,
		() =>
			new Intl.DateTimeFormat(LOCALES[lang], {
				day: "numeric",
				month: "short",
				timeZone: "UTC",
				year: "numeric",
			})
	);
}

/**
 * A storefront code is ISO 3166-1 alpha-2, so Intl can name it in any language.
 *
 * `fallback: "none"` is what makes the unknown case detectable: the default
 * echoes the code straight back, which is indistinguishable from a real answer
 * without comparing strings. With it, an unassigned code returns undefined and
 * the name the reference data carries wins — Apple ships the odd storefront
 * that is not a country, and a bare "QQ" helps nobody.
 */
export function regionName(
	code: string,
	lang: Lang,
	fallback?: string | null
): string {
	const upper = code.toUpperCase();
	try {
		const display = cached(
			regions as Map<string, Intl.DisplayNames>,
			lang,
			() =>
				new Intl.DisplayNames([LOCALES[lang]], {
					fallback: "none",
					type: "region",
				})
		);
		const named = display.of(upper);
		if (named) {
			return named;
		}
	} catch {
		// A code Intl rejects outright; the reference name is the better answer.
	}
	return fallback ?? upper;
}

/** Grouped integer — 1,234 or 1 234 depending on the language. */
export function formatNumber(value: number, lang: Lang): string {
	return cached(
		numbers,
		`${lang}:int`,
		() => new Intl.NumberFormat(LOCALES[lang])
	).format(value);
}

/** Fixed decimals with the right separator: 1.5 in English, 1,5 in French. */
export function formatDecimal(
	value: number,
	lang: Lang,
	digits: number
): string {
	return cached(
		numbers,
		`${lang}:d${digits}`,
		() =>
			new Intl.NumberFormat(LOCALES[lang], {
				maximumFractionDigits: digits,
				minimumFractionDigits: digits,
			})
	).format(value);
}

/**
 * A named month, never a numeric one: 2 Sep 2026 and 2 sept. 2026 both read
 * correctly, where 09/02 and 02/09 are the same date written two ways.
 */
export function formatDay(iso: string, lang: Lang): string {
	const at = Date.parse(`${iso}T00:00:00Z`);
	return Number.isNaN(at) ? iso : dayFormatter(lang).format(at);
}

/**
 * The same calendar day, from the millisecond timestamps Apple's feeds carry.
 * Read in UTC like every observed_date, so a review and a rank collected in
 * the same hour never land on different days.
 */
export function formatDayAt(at: number, lang: Lang): string {
	return dayFormatter(lang).format(new Date(at));
}

/** Clock time for collector activity, in the operator's own convention. */
export function formatTime(at: number, lang: Lang): string {
	return cached(
		dates,
		`${lang}:time`,
		() =>
			new Intl.DateTimeFormat(LOCALES[lang], {
				hour: "2-digit",
				minute: "2-digit",
			})
	).format(new Date(at));
}

/** The same helpers bound to the chosen language, so views never pass it. */
export function useFormat() {
	const { lang } = useI18n();
	return useMemo(
		() => ({
			day: (iso: string) => formatDay(iso, lang),
			dayAt: (at: number) => formatDayAt(at, lang),
			decimal: (value: number, digits: number) =>
				formatDecimal(value, lang, digits),
			number: (value: number) => formatNumber(value, lang),
			region: (code: string, fallback?: string | null) =>
				regionName(code, lang, fallback),
			time: (at: number) => formatTime(at, lang),
		}),
		[lang]
	);
}
