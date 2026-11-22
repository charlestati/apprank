import { Star } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../api";
import type { Review, TrackedApp } from "../api";
import { InfoTip } from "../components/info-tip";
import { useFormat } from "../format";
import { fmt, plural, useT } from "../i18n";

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

/**
 * Five stars, filled up to `filled`. Filled and hollow come from the same
 * icon, so the two halves of a rating share a shape and differ only in fill;
 * two different characters did not. The label is the reading, the icons are
 * decoration.
 */
function Stars({
	filled,
	label,
	size,
}: {
	filled: number;
	label: string;
	size: number;
}) {
	return (
		<span aria-label={label} className="stars">
			{Array.from({ length: 5 }, (_, i) => (
				<Star
					aria-hidden="true"
					className={i < filled ? "star-on" : "star-off"}
					key={`star-${i}`}
					size={size}
				/>
			))}
		</span>
	);
}

const STAR_VALUES = [5, 4, 3, 2, 1] as const;

/**
 * The average and the spread of the reviews on this page, the read a list of
 * cards cannot give at a glance. Computed here from what was loaded, so it is
 * labelled as such: it is not Apple's store rating, which counts ratings
 * without a review and every review past the feed's cap. Each bar prints its
 * count, so the length is never the only way to read it.
 */
function RatingSummary({ reviews }: { reviews: Review[] }) {
	const f = useFormat();
	const t = useT();
	const counts = new Map<number, number>();
	let sum = 0;
	let rated = 0;
	for (const r of reviews) {
		if (r.rating !== null) {
			counts.set(r.rating, (counts.get(r.rating) ?? 0) + 1);
			sum += r.rating;
			rated += 1;
		}
	}
	if (rated === 0) {
		return null;
	}
	const average = sum / rated;
	const most = Math.max(...STAR_VALUES.map((v) => counts.get(v) ?? 0));
	return (
		<section aria-labelledby="rating-summary" className="card rating-summary">
			<h2 className="section-title" id="rating-summary">
				{t.ratingSummary}
				<InfoTip label={t.ratingSummary}>{t.helpRatingSummary}</InfoTip>
			</h2>
			<div className="rating-average">
				<span className="rating-value">{f.decimal(average, 1)}</span>
				<div>
					<Stars
						filled={Math.round(average)}
						label={fmt(t.ratingAverageLabel, { n: f.decimal(average, 1) })}
						size={16}
					/>
					<p className="rating-from">
						{plural(t, rated, "ratingFromOne", "ratingFrom")}
					</p>
				</div>
			</div>
			<dl className="rating-bars">
				{STAR_VALUES.map((value) => {
					const n = counts.get(value) ?? 0;
					return (
						<div className="rating-row" key={value}>
							<dt>
								<span aria-hidden="true" className="rating-key">
									{value}
									<Star className="star-on" size={12} />
								</span>
								<span className="sr-only">
									{plural(t, value, "starLabel", "starsLabel")}
								</span>
							</dt>
							<dd>
								<span aria-hidden="true" className="rating-track">
									<span
										className="rating-fill"
										style={{ width: `${most === 0 ? 0 : (n / most) * 100}%` }}
									/>
								</span>
								<span className="rating-count">{f.number(n)}</span>
							</dd>
						</div>
					);
				})}
			</dl>
		</section>
	);
}

export function Reviews({ app }: { app: TrackedApp | null }) {
	const f = useFormat();
	const t = useT();
	// Stamped with the app they belong to, so switching apps shows the loading
	// state rather than the previous app's reviews, and a slow answer for the
	// previous app cannot land over the current one.
	const [fetched, setFetched] = useState<{
		appId: number;
		/** Null when the request failed, which is not "no reviews". */
		reviews: Review[] | null;
	} | null>(null);
	const appId = app?.id ?? null;
	useEffect(() => {
		if (appId === null) {
			return;
		}
		let live = true;
		(async () => {
			let next: Review[] | null = null;
			try {
				next = await api.reviews(appId);
			} catch {
				// Shown as a failure: "nothing collected yet" would be a statement
				// about the data that a failed request cannot make.
			}
			if (live) {
				setFetched({ appId, reviews: next });
			}
		})();
		return () => {
			live = false;
		};
	}, [appId]);
	const answered = fetched?.appId === appId ? fetched : null;
	const reviews = answered?.reviews ?? null;

	if (!app) {
		return <p className="empty">{t.noAppTracked}</p>;
	}
	if (reviews === null) {
		return (
			<p className="empty">{answered === null ? t.loading : t.loadFailed}</p>
		);
	}

	return (
		<>
			<header className="page-header">
				{/* The trigger beside the heading, not inside it, so the page's
				    title stays its own name. */}
				<div className="page-title">
					<h1>{t.reviews}</h1>
					<InfoTip label={t.reviews}>{t.reviewsIntro}</InfoTip>
				</div>
			</header>
			{reviews.length === 0 && <p className="empty">{t.reviewsEmpty}</p>}
			<div className="reviews-layout">
				<RatingSummary reviews={reviews} />
				<div className="review-list">
					{reviews.map((r) => {
						const flag = f.flag(r.storefront_code);
						return (
							<article
								className={`card review review-${tone(r.rating)}`}
								key={r.id}
							>
								<div className="review-head">
									<Stars
										filled={r.rating ?? 0}
										label={
											r.rating === null
												? t.starsUnrated
												: plural(t, r.rating, "starLabel", "starsLabel")
										}
										size={13}
									/>
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
			</div>
		</>
	);
}
