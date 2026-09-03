import { Activity, ChartLine, Lightbulb, MessageSquare } from "lucide-react";
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
import { Select } from "./components/select";
import { fmt, I18nProvider, LanguagePicker, useI18n, useT } from "./i18n";
import { Health } from "./pages/health";
import { KeywordPerformance } from "./pages/keyword-performance";
import { PairDetail } from "./pages/pair-detail";
import { Reviews } from "./pages/reviews";
import { Suggestions } from "./pages/suggestions";
import {
	cached,
	loadPreferences,
	PREF_APP,
	PREF_LANG,
	savePreference,
	setCached,
} from "./preferences";

/**
 * The last chosen app, from the cache so the first render already has it. The
 * server's copy arrives a moment later and wins; see `preferences.ts`.
 */
function storedAppId(): number | null {
	const raw = cached(PREF_APP);
	const id = raw === null ? Number.NaN : Number(raw);
	return Number.isFinite(id) ? id : null;
}

/**
 * Shown only to an operator who tracks more than one app, because a select
 * with a single option is a control that cannot do anything.
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
		<Select
			hiddenLabel
			label={t.application}
			onValueChange={(id) => {
				onSelect(id);
				if (pathname.startsWith("/pairs/")) {
					navigate("/");
				}
			}}
			options={apps.map((a) => ({
				label: a.current_name ?? `#${a.id}`,
				value: a.id,
			}))}
			value={appId ?? apps[0]?.id ?? 0}
		/>
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
				{fmt(t.searchesToday, {
					done: health.collectedToday,
					total: health.tier1Pairs,
				})}
			</span>
		</NavLink>
	);
}

function Shell() {
	const t = useT();
	const { setLang } = useI18n();
	const [apps, setApps] = useState<TrackedApp[]>([]);
	const [health, setHealth] = useState<DataHealth | null>(null);
	const [userId, setUserId] = useState<string | null>(null);
	const [appId, setAppId] = useState<number | null>(storedAppId);

	// A stored id that is no longer tracked, an app removed since the last
	// visit, falls back rather than rendering an empty report.
	const app = apps.find((a) => a.id === appId) ?? apps[0] ?? null;

	const selectApp = (id: number) => {
		setAppId(id);
		savePreference(PREF_APP, String(id));
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
			// The server's copy last, and it wins: the cache only knows what this
			// browser did, while this row knows what the reader chose anywhere.
			// Applied to state and written back to the cache so the next first
			// paint already agrees.
			const prefs = await loadPreferences();
			const stored = Number(prefs[PREF_APP]);
			if (Number.isFinite(stored)) {
				setAppId(stored);
				setCached(PREF_APP, String(stored));
			}
			const lang = prefs[PREF_LANG];
			if (lang === "en" || lang === "fr") {
				setLang(lang);
			}
		})();
	}, [setLang]);

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

				{/* Icons carry no meaning the label does not already give, so they are
            aria-hidden and sized to the text. They are here to make a
            destination findable by shape once you know where it is, which is
            what a sidebar is used for after the first visit. */}
				<nav aria-label={t.navSections} className="sidebar">
					<p className="nav-heading">{t.appStoreOptimization}</p>
					<NavLink end to="/">
						<ChartLine aria-hidden="true" size={16} />
						{t.keywordPerformance}
					</NavLink>
					<NavLink to="/reviews">
						<MessageSquare aria-hidden="true" size={16} />
						{t.reviews}
					</NavLink>
					<NavLink to="/suggestions">
						<Lightbulb aria-hidden="true" size={16} />
						{t.suggestions}
					</NavLink>

					<p className="nav-heading">{t.collection}</p>
					<NavLink to="/health">
						<Activity aria-hidden="true" size={16} />
						{t.dataHealth}
					</NavLink>
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
