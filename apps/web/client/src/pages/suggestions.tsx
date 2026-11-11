import { useEffect, useState } from "react";

import { api } from "../api";
import type { PromoteKeyword, Suggestion } from "../api";
import { fmt, useT } from "../i18n";

/**
 * A suggestion the collector wrote, or null when we cannot read it.
 *
 * A payload this page does not understand is shown as itself rather than
 * hidden: the row is a real decision waiting on someone, and swallowing it
 * would leave the operator with a queue that silently disagrees with its own
 * count.
 */
function promotion(s: Suggestion): PromoteKeyword | null {
	if (s.type !== "promote_keyword") {
		return null;
	}
	try {
		const p = JSON.parse(s.payload) as Partial<PromoteKeyword> | null;
		// Every field the card prints, not the term alone: a payload missing its
		// storefront threw in render, and with no error boundary that blanked
		// the whole dashboard.
		return typeof p?.term === "string" &&
			typeof p.seed === "string" &&
			typeof p.storefront === "string"
			? (p as PromoteKeyword)
			: null;
	} catch {
		return null;
	}
}

export function Suggestions() {
	const t = useT();
	const [rows, setRows] = useState<Suggestion[] | "failed" | null>(null);
	// A set: two answers can be in flight at once, and a single id let the
	// first one to settle re-enable the other row's buttons mid-request.
	const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
	const release = (id: number) =>
		setBusy((current) => new Set([...current].filter((held) => held !== id)));

	useEffect(() => {
		(async () => {
			try {
				setRows(await api.suggestions());
			} catch {
				// Not an empty queue: "nothing pending" would hide decisions that
				// are still waiting.
				setRows("failed");
			}
		})();
	}, []);

	// The row leaves the list on success, because the server has already moved it
	// out of "pending" and a re-fetch would cost a round trip to learn that.
	// No `finally`: the React compiler cannot lower one, and the two paths want
	// different things anyway. A row that left the list has no button to re-enable.
	const answer = async (id: number, status: "accepted" | "dismissed") => {
		setBusy((current) => new Set([...current, id]));
		try {
			await api.answerSuggestion(id, status);
			setRows((current) =>
				Array.isArray(current) ? current.filter((s) => s.id !== id) : current
			);
			release(id);
		} catch {
			// Leave the row in place: an answer that did not reach the server must
			// not look like one that did.
			release(id);
		}
	};

	if (rows === null) {
		return <p className="empty">{t.loading}</p>;
	}
	if (rows === "failed") {
		return <p className="empty">{t.loadFailed}</p>;
	}
	return (
		<>
			<header className="page-header">
				<div>
					<h1>{t.suggestions}</h1>
					<p className="page-sub">{t.suggestionsIntro}</p>
				</div>
			</header>
			{rows.length === 0 && <p className="empty">{t.suggestionsEmpty}</p>}
			{rows.map((s) => {
				const p = promotion(s);
				return (
					<article className="card suggestion" key={s.id}>
						{p ? (
							<div className="suggestion-body">
								<div>
									<h2 className="suggestion-term">{p.term}</h2>
									<p className="suggestion-why">
										{fmt(t.suggestionWhy, {
											seed: p.seed,
											storefront: p.storefront.toUpperCase(),
										})}
									</p>
								</div>
								<div className="suggestion-actions">
									<button
										className="button"
										disabled={busy.has(s.id)}
										onClick={() => answer(s.id, "dismissed")}
										type="button"
									>
										{t.dismiss}
									</button>
									{/* Accepting spends crawl budget from here on, so it says
                      what it does rather than just "OK". */}
									<button
										className="button button-primary"
										disabled={busy.has(s.id)}
										onClick={() => answer(s.id, "accepted")}
										type="button"
									>
										{t.trackKeyword}
									</button>
								</div>
							</div>
						) : (
							<>
								<h2 className="section-title">{s.type}</h2>
								<pre
									aria-label={t.suggestionPayload}
									className="suggestion-payload"
								>
									{s.payload}
								</pre>
							</>
						)}
					</article>
				);
			})}
		</>
	);
}
