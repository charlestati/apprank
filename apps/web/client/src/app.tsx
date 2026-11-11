import { Activity, ChartLine, Lightbulb, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
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
import {
	fmt,
	I18nProvider,
	LanguagePicker,
	plural,
	useI18n,
	useT,
} from "./i18n";
import { Health } from "./pages/health";
import { KeywordPerformance } from "./pages/keyword-performance";
import { PairDetail } from "./pages/pair-detail";
import { Reviews } from "./pages/reviews";
import { Suggestions } from "./pages/suggestions";
import {
	cached,
	loadPreferences,
	PREF_APP,
	PREF_HEALTH_ACK,
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

/**
 * Today's progress, and nothing else.
 *
 * Errors used to live here too, and it made the topbar useless: a count that
 * was red every day of the first twelve stops being read. Failures belong where
 * there is room to say what they were, so they are on the health page, and the
 * sidebar carries a badge to get the reader there.
 */
function CollectionStatus({ health }: { health: DataHealth | null }) {
	const t = useT();
	if (!health) {
		return null;
	}
	const complete =
		health.tier1Pairs > 0 && health.collectedToday >= health.tier1Pairs;
	const tone = complete
		? "lozenge lozenge-success"
		: "lozenge lozenge-inprogress";
	const text = complete ? t.complete : t.collecting;

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

/**
 * The newest lost observation in the window, or 0 when nothing was lost.
 * Throttles and Apple-side findings carry `loss: false` and are ignored here,
 * the same rule the server uses for `lostLast24h`.
 */
function newestLoss(health: DataHealth | null): number {
	let newest = 0;
	for (const e of health?.errorsLast24h ?? []) {
		if (e.loss && e.lastAt > newest) {
			newest = e.lastAt;
		}
	}
	return newest;
}

function Shell() {
	const t = useT();
	const { adoptLang } = useI18n();
	// Null until the list answers, and "failed" when it does not. An empty array
	// means the operator tracks nothing, which is a different sentence: starting
	// from [] printed "No app is being tracked yet." on every load until the
	// answer landed, and for good when it never did.
	const [apps, setApps] = useState<TrackedApp[] | "failed" | null>(null);
	const [health, setHealth] = useState<DataHealth | null>(null);
	const [userId, setUserId] = useState<string | null>(null);
	const [appId, setAppId] = useState<number | null>(storedAppId);
	const [healthAck, setHealthAck] = useState(Number(cached(PREF_HEALTH_ACK)));

	const tracked = Array.isArray(apps) ? apps : [];
	// A stored id that is no longer tracked, an app removed since the last
	// visit, falls back rather than rendering an empty report.
	const app = tracked.find((a) => a.id === appId) ?? tracked[0] ?? null;

	const selectApp = (id: number) => {
		setAppId(id);
		savePreference(PREF_APP, String(id));
	};

	// Acknowledge up to the newest loss we are showing, not to "now": anything
	// that arrives after this click is new information and badges again.
	const lost = newestLoss(health);
	const unread = lost > 0 && lost > healthAck ? (health?.lostLast24h ?? 0) : 0;
	const acknowledgeHealth = () => {
		setHealthAck(lost);
		savePreference(PREF_HEALTH_ACK, String(lost));
	};

	// The browser holds the credentials: by the time this renders, the request
	// for the page itself was already authenticated.
	//
	// Four independent requests, started together. Awaited one after another
	// they made the first report wait on three round trips it does not need.
	useEffect(() => {
		(async () => {
			try {
				const me = await api.me();
				setUserId(me.userId);
			} catch {
				setUserId(null);
			}
		})();
		(async () => {
			try {
				setApps(await api.apps());
			} catch {
				setApps("failed");
			}
		})();
		(async () => {
			try {
				setHealth(await api.health());
			} catch {
				setHealth(null);
			}
		})();
		(async () => {
			// The server's copy wins over the cache: the cache only knows what
			// this browser did, while this row knows what the reader chose
			// anywhere. `loadPreferences` lays this session's own writes over it,
			// so an answer that left before a click cannot undo the click.
			// Applied to state and written back to the cache so the next first
			// paint already agrees.
			const prefs = await loadPreferences();
			const stored = Number(prefs[PREF_APP]);
			if (prefs[PREF_APP] !== undefined && Number.isFinite(stored)) {
				setAppId(stored);
				setCached(PREF_APP, String(stored));
			}
			const lang = prefs[PREF_LANG];
			if (lang === "en" || lang === "fr") {
				adoptLang(lang);
			}
			// The acknowledgement too: it was written here and read nowhere, so
			// a badge dismissed on one machine came back on every other.
			const ack = Number(prefs[PREF_HEALTH_ACK]);
			if (prefs[PREF_HEALTH_ACK] !== undefined && Number.isFinite(ack)) {
				setHealthAck(ack);
				setCached(PREF_HEALTH_ACK, String(ack));
			}
		})();
	}, [adoptLang]);

	// The pages that show one app's data wait for the list rather than guess at
	// it, and say so when it could not be read.
	const forApp = (page: ReactElement): ReactElement => {
		if (apps === null) {
			return <p className="empty">{t.loading}</p>;
		}
		return apps === "failed" ? <p className="empty">{t.appsFailed}</p> : page;
	};

	return (
		<BrowserRouter>
			<div className="shell">
				<header className="topbar">
					<Wordmark />
					{tracked.length > 1 ? (
						<AppPicker
							appId={app?.id ?? null}
							apps={tracked}
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
						{unread > 0 && (
							<span
								aria-label={plural(t, unread, "lostAriaOne", "lostAria")}
								className="nav-badge"
							>
								{unread}
							</span>
						)}
					</NavLink>
				</nav>

				<main>
					<Routes>
						<Route
							element={forApp(<KeywordPerformance app={app} />)}
							path="/"
						/>
						<Route
							element={forApp(<PairDetail app={app} />)}
							path="/pairs/:pairId"
						/>
						<Route element={forApp(<Reviews app={app} />)} path="/reviews" />
						<Route element={<Suggestions />} path="/suggestions" />
						<Route
							element={
								<Health onAcknowledge={acknowledgeHealth} unread={unread} />
							}
							path="/health"
						/>
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
