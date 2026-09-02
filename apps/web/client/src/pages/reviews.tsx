import { useEffect, useState } from "react";

import { api } from "../api";
import type { Review, TrackedApp } from "../api";
import { useFormat } from "../format";
import { useT, fmt } from "../i18n";

export function Reviews({ app }: { app: TrackedApp | null }) {
	const f = useFormat();
	const t = useT();
	const [reviews, setReviews] = useState<Review[] | null>(null);
	useEffect(() => {
		if (!app) {
			return;
		}
		(async () => {
			try {
				setReviews(await api.reviews(app.id));
			} catch {
				setReviews([]);
			}
		})();
	}, [app]);

	if (!app) {
		return <p className="empty">{t.noAppTracked}</p>;
	}
	if (reviews === null) {
		return <p className="empty">{t.loading}</p>;
	}

	return (
		<>
			<header className="page-header">
				<div>
					<h1>{t.reviews}</h1>
					<p className="page-sub">{t.reviewsIntro}</p>
				</div>
			</header>
			{reviews.length === 0 && <p className="empty">{t.reviewsEmpty}</p>}
			{reviews.map((r) => (
				<article className="card review" key={r.id}>
					<h3>
						<span
							className="stars"
							aria-label={fmt(t.starsLabel, { n: r.rating ?? "?" })}
						>
							{"★".repeat(r.rating ?? 0)}
							{"☆".repeat(Math.max(0, 5 - (r.rating ?? 0)))}
						</span>{" "}
						{r.title}
					</h3>
					<div className="meta">
						{r.author} · {r.storefront_code.toUpperCase()} · v{r.app_version} ·{" "}
						{r.reviewed_at ? f.dayAt(r.reviewed_at) : ""}
					</div>
					<p className="review-body">{r.body}</p>
				</article>
			))}
		</>
	);
}
