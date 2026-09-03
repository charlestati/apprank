import { useEffect, useState } from "react";

import { api } from "../api";
import type { Suggestion } from "../api";
import { useT } from "../i18n";

export function Suggestions() {
	const t = useT();
	const [rows, setRows] = useState<Suggestion[] | null>(null);
	useEffect(() => {
		(async () => {
			try {
				setRows(await api.suggestions());
			} catch {
				setRows([]);
			}
		})();
	}, []);

	if (rows === null) {
		return <p className="empty">{t.loading}</p>;
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
			{rows.map((s) => (
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
