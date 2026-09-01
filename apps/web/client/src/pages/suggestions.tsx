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
				<div className="card" key={s.id} style={{ marginBottom: 8 }}>
					<strong>{s.type}</strong>
					<pre
						style={{
							color: "var(--ink-2)",
							fontSize: 12,
							margin: "6px 0 0",
							whiteSpace: "pre-wrap",
						}}
					>
						{s.payload}
					</pre>
				</div>
			))}
		</>
	);
}
