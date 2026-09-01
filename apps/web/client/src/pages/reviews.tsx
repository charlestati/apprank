import { useEffect, useState } from "react";

import { api } from "../api";
import type { Review, TrackedApp } from "../api";
import { useFormat } from "../format";
import { useT } from "../i18n";

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
    return <p className="empty">No app is being tracked yet.</p>;
  }
  if (reviews === null) {
    return <p className="empty">Loading…</p>;
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t.reviews}</h1>
          <p className="page-sub">
            Most recent reviews across storefronts. Apple&apos;s feed caps at
            the latest 500 per storefront.
          </p>
        </div>
      </header>
      {reviews.length === 0 && (
        <p className="empty">
          Nothing collected yet — the daily pull fills this in.
        </p>
      )}
      {reviews.map((r) => (
        <article className="card review" key={r.id}>
          <h3>
            <span className="stars" aria-label={`${r.rating ?? "?"} stars`}>
              {"★".repeat(r.rating ?? 0)}
              {"☆".repeat(Math.max(0, 5 - (r.rating ?? 0)))}
            </span>{" "}
            {r.title}
          </h3>
          <div className="meta">
            {r.author} · {r.storefront_code.toUpperCase()} · v{r.app_version} ·{" "}
            {r.reviewed_at ? f.dayAt(r.reviewed_at) : ""}
          </div>
          <p style={{ margin: "6px 0 0" }}>{r.body}</p>
        </article>
      ))}
    </>
  );
}
