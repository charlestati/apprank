// The full result page behind one observation. We keep 200 track ids per
// crawl, so this is the deep view: rank 47 today is what tells you when a
// climb started. Apps we have never met show as ids — honest, not dropped.

import { useEffect, useState } from "react";

import { api } from "../api";
import type { KeywordRow, ResultPage } from "../api";
import { useFormat } from "../format";
import { AppIcon } from "./app-icon";

interface Props {
  row: KeywordRow;
  storefront: string;
  trackedAppId: number | null;
  onClose: () => void;
}

export function ResultsDrawer({
  row,
  storefront,
  trackedAppId,
  onClose,
}: Props) {
  const f = useFormat();
  const [page, setPage] = useState<ResultPage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setPage(await api.results(row.pairId));
      } catch {
        setFailed(true);
      }
    })();
  }, [row.pairId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside aria-label={`Search results for ${row.keyword}`} className="drawer">
      <header className="drawer-head">
        <div>
          <h2>“{row.keyword}”</h2>
          <p className="drawer-sub">
            {f.region(storefront)} ·{" "}
            {page?.date ? `observed ${f.day(page.date)}` : "loading…"}
            {page ? ` · ${f.number(page.resultCount)} results` : ""}
          </p>
        </div>
        <button className="link" onClick={onClose} type="button">
          Close
        </button>
      </header>

      {failed ? <p className="empty">Could not load the result page.</p> : null}

      <ol className="result-list">
        {(page?.results ?? []).map((r) => (
          <li
            className={
              r.appId === trackedAppId ? "result-row row-self" : "result-row"
            }
            key={r.appId}
          >
            <span className="result-position">{r.position}</span>
            <AppIcon
              className="result-icon"
              iconUrl={r.iconUrl}
              name={r.name}
            />
            <span className="result-name">
              {r.name ?? `App ${r.appId}`}
              {r.developer ? (
                <span className="result-developer">{r.developer}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
