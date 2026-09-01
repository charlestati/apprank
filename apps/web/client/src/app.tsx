import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";

import { api } from "./api";
import type { DataHealth, TrackedApp } from "./api";
import { I18nProvider, LanguagePicker, useT } from "./i18n";
import { Health } from "./pages/health";
import { KeywordPerformance } from "./pages/keyword-performance";
import { PairDetail } from "./pages/pair-detail";
import { Reviews } from "./pages/reviews";
import { Suggestions } from "./pages/suggestions";

function Wordmark() {
  return (
    <a aria-label="AppRank" className="wordmark" href="/">
      {[..."APPRANK"].map((ch, i) => (
        <span key={`${ch}-${i}`}>{ch}</span>
      ))}
    </a>
  );
}

function CollectionStatus({ health }: { health: DataHealth | null }) {
  const t = useT();
  if (!health) {
    return null;
  }
  const errors = health.errorsLast24h.reduce((a, e) => a + e.n, 0);
  const complete =
    health.tier1Pairs > 0 && health.collectedToday >= health.tier1Pairs;

  let tone = "lozenge lozenge-inprogress";
  let text = t.collecting;
  if (errors > 0) {
    tone = "lozenge lozenge-removed";
    text = `${errors} ${errors === 1 ? t.collectionError : t.collectionErrors}`;
  } else if (complete) {
    tone = "lozenge lozenge-success";
    text = t.complete;
  }

  return (
    <NavLink className="status-link" to="/health">
      <span className={tone}>{text}</span>
      <span className="status-count">
        {health.collectedToday}/{health.tier1Pairs} {t.today}
      </span>
    </NavLink>
  );
}

function Shell() {
  const t = useT();
  const [apps, setApps] = useState<TrackedApp[]>([]);
  const [health, setHealth] = useState<DataHealth | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const app = apps[0] ?? null; // an app switcher arrives with multi-app usage

  // The browser holds the credentials: by the time this renders, the request
  // for the page itself was already authenticated.
  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setUserId(me.userId);
      } catch {
        setUserId(null);
      }
      try {
        setApps(await api.apps());
      } catch {
        setApps([]);
      }
      try {
        setHealth(await api.health());
      } catch {
        setHealth(null);
      }
    })();
  }, []);

  return (
    <BrowserRouter>
      <div className="shell">
        <header className="topbar">
          <Wordmark />
          <span className="app-name">{app?.current_name ?? ""}</span>
          <span className="spacer" />
          <CollectionStatus health={health} />
          <LanguagePicker />
          {userId ? <span className="who">{userId}</span> : null}
        </header>

        <nav aria-label="Sections" className="sidebar">
          <p className="nav-heading">{t.appStoreOptimization}</p>
          <NavLink end to="/">
            {t.keywordPerformance}
          </NavLink>
          <NavLink to="/reviews">{t.reviews}</NavLink>
          <NavLink to="/suggestions">{t.suggestions}</NavLink>

          <p className="nav-heading">{t.collection}</p>
          <NavLink to="/health">{t.dataHealth}</NavLink>
        </nav>

        <main>
          <Routes>
            <Route element={<KeywordPerformance app={app} />} path="/" />
            <Route element={<PairDetail app={app} />} path="/pairs/:pairId" />
            <Route element={<Reviews app={app} />} path="/reviews" />
            <Route element={<Suggestions />} path="/suggestions" />
            <Route element={<Health />} path="/health" />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}
