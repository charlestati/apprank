import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../api";
import type { PromoteKeyword, Suggestion } from "../api";
import { InfoTip } from "../components/info-tip";
import { useFormat } from "../format";
import { useT } from "../i18n";

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
	const f = useFormat();
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
	// Readable promotions go in one table; anything else keeps its own card
	// with the raw payload, which is a decision too and must not be hidden.
	const promotions = rows.flatMap((s) => {
		const p = promotion(s);
		return p ? [{ id: s.id, p }] : [];
	});
	const others = rows.filter((s) => promotion(s) === null);
	return (
		<>
			<header className="page-header">
				<div className="page-title">
					<h1>{t.suggestions}</h1>
					<InfoTip label={t.suggestions}>{t.suggestionsIntro}</InfoTip>
				</div>
			</header>
			{rows.length === 0 && <p className="empty">{t.suggestionsEmpty}</p>}
			{/* One row per suggestion rather than a card with a sentence: the same
			    term comes back once per storefront, and as cards that was a page
			    of near-identical prose. Each row keeps its own answer, because
			    the server answers per suggestion. */}
			{promotions.length > 0 && (
				<section className="card table-card suggestion-table">
					<div className="table-scroll">
						<table className="suggestion-grid grid">
							<thead>
								<tr>
									<th>{t.keyword}</th>
									<th>
										{t.suggestedAlongside}
										<InfoTip label={t.suggestedAlongside}>
											{t.helpSuggestedAlongside}
										</InfoTip>
									</th>
									<th>{t.storefront}</th>
									<th className="col-actions">
										<span className="sr-only">{t.actions}</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{promotions.map(({ id, p }) => {
									const flag = f.flag(p.storefront);
									return (
										<tr key={id}>
											<td className="suggestion-term">{p.term}</td>
											<td
												className="subtle suggestion-seed"
												data-label={t.suggestedAlongside}
											>
												{p.seed}
											</td>
											<td className="suggestion-store">
												{/* The flag decorates the code, never replaces it: a
												    platform with no flag glyphs draws the letters. */}
												<span className="storefront-code">
													{flag && <span aria-hidden="true">{flag}</span>}
													<abbr title={f.region(p.storefront)}>
														{p.storefront.toUpperCase()}
													</abbr>
												</span>
											</td>
											<td className="col-actions">
												<div className="suggestion-actions">
													<button
														className="button button-small"
														disabled={busy.has(id)}
														onClick={() => answer(id, "dismissed")}
														type="button"
													>
														<X aria-hidden="true" size={14} />
														{t.dismiss}
													</button>
													{/* Accepting spends crawl budget from here on, so it
													    says what it does rather than just "OK". */}
													<button
														className="button button-small button-primary"
														disabled={busy.has(id)}
														onClick={() => answer(id, "accepted")}
														type="button"
													>
														<Plus aria-hidden="true" size={14} />
														{t.trackKeyword}
													</button>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</section>
			)}
			{others.map((s) => (
				<article className="card suggestion" key={s.id}>
					<h2 className="section-title">{s.type}</h2>
					<pre aria-label={t.suggestionPayload} className="suggestion-payload">
						{s.payload}
					</pre>
				</article>
			))}
		</>
	);
}
