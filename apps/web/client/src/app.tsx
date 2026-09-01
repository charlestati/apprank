import { useEffect, useState } from "react";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";

import { api } from "./api";
import type { DataHealth, TrackedApp } from "./api";
import { I18nProvider, LanguagePicker, useT } from "./i18n";
import { Health } from "./pages/health";
import { KeywordPerformance } from "./pages/keyword-performance";
import { PairDetail } from "./pages/pair-detail";
import { Reviews } from "./pages/reviews";
import { Suggestions } from "./pages/suggestions";

const APP_STORAGE_KEY = "apprank.app";

/** The last chosen app, if storage is readable and still holds a number. */
function storedAppId(): number | null {
  try {
    const raw = localStorage.getItem(APP_STORAGE_KEY);
    const id = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    // Storage unavailable; the first tracked app is a fine default.
    return null;
  }
}

/**
 * Shown only to an operator who tracks more than one app — a select with a
 * single option is a control that cannot do anything.
 *
 * Switching while on a pair detail returns to the report, because that route
 * addresses one pair of the app being left behind: keeping it would render
 * another app's keyword under the newly chosen name.
 */
function AppPicker({
  apps,
  appId,
  onSelect,
}: {
  apps: TrackedApp[];
  appId: number | null;
  onSelect: (id: number) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <label className="app-picker">
      <span className="sr-only">{t.application}</span>
      <select
        onChange={(e) => {
          onSelect(Number(e.target.value));
          if (pathname.startsWith("/pairs/")) {
            navigate("/");
          }
        }}
        value={appId ?? ""}
      >
        {apps.map((a) => (
          <option key={a.id} value={a.id}>
            {a.current_name ?? `#${a.id}`}
          </option>
        ))}
      </select>
    </label>
  );
}

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
  const [appId, setAppId] = useState<number | null>(storedAppId);

  // A stored id that is no longer tracked — an app removed since the last
  // visit — falls back rather than rendering an empty report.
  const app = apps.find((a) => a.id === appId) ?? apps[0] ?? null;

  const selectApp = (id: number) => {
    setAppId(id);
    try {
      localStorage.setItem(APP_STORAGE_KEY, String(id));
    } catch {
      // A choice we cannot persist is still worth honouring this session.
    }
  };

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
          {apps.length > 1 ? (
            <AppPicker
              appId={app?.id ?? null}
              apps={apps}
              onSelect={selectApp}
            />
          ) : (
            <span className="app-name">{app?.current_name ?? ""}</span>
          )}
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
