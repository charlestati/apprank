// Where the reader's choices live: the app the switcher landed on, the UI
// language, and the keywords drawn on the chart.
//
// Two stores, on purpose. The database is the durable one, so a choice survives
// a different browser and a cleared cache. localStorage is a cache in front of
// it, because both the app and the language are needed *before* the first
// paint, and waiting on a round trip to know which language to render in would
// show the wrong one and then swap it.
//
// So: paint from the cache, then reconcile with the server, which wins because
// it is the only copy that knows about the reader's other machine. A write goes
// to both, the cache first so the interface never waits on the network to
// acknowledge a click.

export const PREF_APP = "app";
// "lang", not "language": this is the key the cache has always used, and
// renaming it would silently reset every reader who already has one stored.
export const PREF_LANG = "lang";

/** The chart's selection varies by app and storefront; the other two do not. */
export function chartKey(appId: number, storefront: string): string {
	return `chart:${appId}:${storefront}`;
}

/**
 * localStorage throws outright in some privacy modes rather than returning
 * null, so every access is guarded. A preference we cannot cache is still
 * worth honouring for this session.
 */
export function cached(key: string): string | null {
	try {
		return localStorage.getItem(`apprank.${key}`);
	} catch {
		return null;
	}
}

export function setCached(key: string, value: string | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(`apprank.${key}`);
		} else {
			localStorage.setItem(`apprank.${key}`, value);
		}
	} catch {
		// Nothing to do: the choice still holds for this session.
	}
}

/** Every stored preference, in one request, for the shell's first effect. */
export async function loadPreferences(): Promise<Record<string, string>> {
	try {
		const res = await fetch("/api/preferences");
		return res.ok ? ((await res.json()) as Record<string, string>) : {};
	} catch {
		// Offline or refused: the cache is still a usable answer.
		return {};
	}
}

/**
 * Write one preference to both stores.
 *
 * Deliberately not awaited by its callers and deliberately silent on failure.
 * A choice the reader has already seen take effect must not be undone because
 * the write did not land, and there is nothing useful to say about it: the
 * cache holds it for this session and the next write will try again.
 */
export function savePreference(key: string, value: string | null): void {
	setCached(key, value);
	(async () => {
		try {
			await fetch(`/api/preferences/${encodeURIComponent(key)}`, {
				body: JSON.stringify({ value }),
				headers: { "content-type": "application/json" },
				method: "PUT",
			});
		} catch {
			// See above.
		}
	})();
}
