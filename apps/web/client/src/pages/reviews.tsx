import { Star } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../api";
import type { Review, TrackedApp } from "../api";
import { useFormat } from "../format";
import { useT, fmt } from "../i18n";

/**
 * Sentiment band for the rail down the left edge of a card. Apple's own split
 * is what these follow: 4 and 5 are the ratings that lift a store average, 3
 * is the shrug, 1 and 2 are the ones worth reading first. An unrated review
 * gets the neutral rail rather than being guessed into a band.
 */
function tone(rating: number | null): string {
	if (rating === null) {
		return "unrated";
	}
	if (rating >= 4) {
		return "positive";
	}
	return rating === 3 ? "neutral" : "negative";
}

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
			<div className="review-list">
				{reviews.map((r) => {
					const flag = f.flag(r.storefront_code);
					return (
						<article
							className={`card review review-${tone(r.rating)}`}
							key={r.id}
						>
							<div className="review-head">
								<span
									className="stars"
									aria-label={fmt(t.starsLabel, { n: r.rating ?? "?" })}
								>
									{/* Filled and hollow stars from the same icon, so the two
                      halves of the rating share a shape and differ only in
                      fill. Two different characters did not. */}
									{Array.from({ length: 5 }, (_, i) => (
										<Star
											aria-hidden="true"
											className={i < (r.rating ?? 0) ? "star-on" : "star-off"}
											key={`${r.id}-star-${i}`}
											size={13}
										/>
									))}
								</span>
								{r.reviewed_at !== null && (
									<time
										className="review-date"
										dateTime={new Date(r.reviewed_at).toISOString()}
									>
										{f.dayAt(r.reviewed_at)}
									</time>
								)}
							</div>
							{r.title && <h3>{r.title}</h3>}
							{r.body && <p className="review-body">{r.body}</p>}
							<div className="review-tags">
								{r.author && (
									<span className="review-tag review-author">{r.author}</span>
								)}
								{/* The flag is decoration over the name, never a replacement:
                  read aloud it is another "France", and on a platform with no
                  flag glyphs it is the letters again. A storefront Intl cannot
                  name drops the glyph rather than leaving the tag's gap
                  hanging off an empty span. */}
								<span className="review-tag">
									{flag && <span aria-hidden="true">{flag}</span>}
									{f.region(r.storefront_code)}
								</span>
								{r.app_version && (
									<span className="review-tag review-version">
										{fmt(t.reviewVersion, { version: r.app_version })}
									</span>
								)}
							</div>
						</article>
					);
				})}
			</div>
		</>
	);
}
