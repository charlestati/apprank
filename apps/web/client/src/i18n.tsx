// Interface language. Two locales, one dictionary, no library.
//
// A translation runtime (i18next and friends) would be several times the size
// of everything it translates here, and this dashboard has one audience and a
// fixed vocabulary. A typed record keeps the compiler enforcing what a library
// would only catch at runtime: `Dictionary` is derived from the English keys,
// so a missing French string is a build error, not a stray English word in the
// middle of a French page.
//
// The verdict sentences deliberately come from `reasonKey`, not from the prose
// the API returns. Classification is the server's job and stays there; how it
// reads is the client's.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Select } from "./components/select";

export type Lang = "en" | "fr";

const STORAGE_KEY = "apprank.lang";

const en = {
	// Shell
	appStoreOptimization: "App Store Optimization",
	collecting: "Collecting",
	collection: "Collection",
	complete: "Complete",
	dataHealth: "Data health",
	keywordPerformance: "Keyword performance",
	reviews: "Reviews",
	suggestions: "Suggestions",
	today: "today",
	collectionError: "collection error",
	collectionErrors: "collection errors",
	application: "Application",
	language: "Language",

	// Opportunity lanes
	laneBlocked: "Blocked",
	laneBlockedHint:
		"Volume exists, but the leaders are entrenched. This needs more than metadata.",
	laneClose: "Within reach",
	laneCloseHint:
		"Within reach of the visible zone. This is where a release should aim.",
	laneUnknown: "No volume data",
	laneUnknownHint:
		"Ranking, but Apple publishes no volume for these terms, so judge them on rank and difficulty.",
	laneVanity: "Vanity ranks",
	laneVanityHint:
		"Ranked where nobody searches. Candidates to reclaim at the next release.",
	laneWinning: "Winning",
	laneWinningHint: "Top 10 on a term with real volume. Defend these.",
	whatToWorkOn: "What to work on",
	genericProgress: "{inZone} of {total} generic keywords are in the top 10.",
	brandCounted: "{n} brand terms are counted separately.",
	brandCountedOne: "1 brand term is counted separately.",
	coverageNote: "Apple publishes no volume for {n} of {total}.",

	// Verdict reasons, keyed to the server's ReasonKey.
	reasonBlocked:
		"Real volume, but the top of the page is entrenched, so metadata alone will not win it.",
	reasonClose: "Within reach of the visible zone on a term that has volume.",
	reasonDormantDeep:
		"Too far down to earn taps, with no evidence the climb is short.",
	reasonDormantUnranked:
		"Not ranking at all: either the metadata does not cover it or the term is out of reach.",
	reasonUnknownReachable:
		"Close enough to push, but Apple publishes no volume for this term, so the payoff is unmeasured.",
	reasonUnknownTapZone:
		"Top 10, but Apple publishes no search volume for this term, so a win and a vanity rank look identical here.",
	reasonVanity:
		"Ranked where almost nobody searches; the slot may be worth reclaiming.",
	reasonWinning: "Top 10 on a term with real volume, so defend it.",

	// Keyword performance page
	anyPopularity: "Any popularity",
	bandVeryHigh: "Very high (85–100)",
	bandHigh: "High (60–84)",
	bandMedium: "Medium (20–59)",
	bandLow: "Low (10–19)",
	bandVeryLow: "Very low (0–9)",
	bestWorst: "Best / worst",
	daysObserved: "{n} days observed",
	dayObserved: "{n} day observed",
	filterByPopularity: "Filter by popularity",
	chartCaption:
		"Rank of {app} for {n} keywords, {from} to {to}. Rank 1 is at the top. A gap is a day with no observation, never a flat rank; days outside the top 200 and days the fetch failed sit on their own rails below the plot. Every keyword and its latest rank are listed in the table below.",
	filterKeywords: "Filter keywords",
	filterNKeywords: "Filter {n} keywords",
	keywordInsights: "Keyword insights",
	noAppTracked: "No app is being tracked yet.",
	nOfMShown: "{n} of {total} shown",
	pageSub: "Where {app} ranks in App Store search, day by day.",
	position: "Position",
	rangeDays: "{n} days",
	reportFailed: "That report could not be loaded. Check the data health page.",
	searchRank: "Search rank",
	searchResults: "Search results",
	timePeriod: "Time period",
	topResults: "Top results",
	total: "Total",
	unprovenTitle:
		"moved in the last 48h; Apple reshuffles, so this has not settled",

	// Tiles, drawer, secondary pages
	app: "App",
	averageRank: "Average rank",
	beyond100: "> 100",
	classLabel: "Class",
	count: "Count",
	lastSeen: "Last seen",
	detail: "Detail",
	noErrors: "Clean. No errors recorded.",
	difficultyFewIncumbents: "few known incumbents",
	difficultyUnscored: "not scored yet, needs a ranked observation",
	rankDistribution: "Rank distribution",
	ranked: "Ranked",
	keywordMovement: "Keyword movement",
	top10ShareTitle: "share of observed days this app appeared in the top 10",
	top10Today: "Top 10 today",
	top25: "Top 25",
	top5: "Top 5",
	top100: "Top 100",
	unchanged: "Unchanged",
	wentDown: "Went down",
	wentUp: "Went up",

	// Table & filters
	view: "View",
	contestedTitle:
		"{n} more results than at the start of the window, so the term is getting more contested",
	pairDetailSub:
		"Rank of {app} in the top 200, daily. Gaps are missing observations, not flat ranks.",
	theTrackedApp: "the tracked app",
	top10Presence: "Top-10 presence",
	suggestionPayload: "Payload",
	best: "Best",
	change: "Change",
	difficulty: "Difficulty",
	export: "Export CSV",
	keyword: "Keyword",
	keywords: "Keywords",
	loading: "Loading…",
	popularity: "Popularity",
	results: "Results",
	storefront: "Storefront",
	unproven: "Unproven",
	worst: "Worst",

	// Data health
	ascAnomalies: "ASC anomalies",
	ascAnomaliesNote: "duplicate / skipped report dates",
	budgetPending: "not computed yet, runs with the daily jobs",
	budgetReserved: "{n} fetches/day reserved for app pulls.",
	collapse: "Collapse",
	healthCoverageNote: "{pct}% of Tier-1 pairs observed ({date})",
	coverageToday: "Coverage today",
	crawlBudget: "Crawl budget",
	crawlPaused: "paused until {time}",
	crawlRate: "Crawl rate",
	crawlRateNote: "fetches/min, learned",
	dailyCompleted: "completed",
	dailyFailed: "failed",
	dailyNoRun: "no run recorded yet",
	dailyQueuedSuffix: " · queued {n}",
	dailyUnfinished: "started and never finished",
	errorsLast24h: "Errors, last 24h",
	expand: "Expand",
	healthIntro:
		"Visible gaps beat silent garbage. Anything red here means today's numbers need a second look.",
	lastDailyJob: "Last daily job",
	loopNeverTicked: "never ticked, the collector has not run",
	loopQueued: "{n} queued",
	loopQueueEmpty: "queue empty",
	loopSinceTick: "since last tick",
	overdueNote: "past due by more than one interval",
	overduePairs: "Overdue pairs",
	throttleHits: "Throttle hits (24h)",
	throttleNote: "403/429 from Apple",
	workLoop: "Work loop",

	// Result page drawer
	appFallback: "App {id}",
	close: "Close",
	drawerFailed: "Could not load the result page.",
	drawerObserved: "observed {date}",
	drawerResultCount: "{n} results",
	drawerSearchResults: "Search results for {keyword}",

	// Reviews
	reviewsEmpty: "Nothing collected yet. The daily pull fills this in.",
	reviewsIntro:
		"Most recent reviews across storefronts. Apple's feed caps at the latest 500 per storefront.",
	starsLabel: "{n} stars",
	noCompetitorData: "No competitor data yet.",
	noKeywordMatch: "No keywords match “{filter}”.",
	noRankedObservations:
		"No ranked observations in this window yet. The collector fills this in daily.",
	suggestionsEmpty: "Inbox empty. The global market sweep populates this.",
	suggestionsIntro:
		"Promotions the global sweep proposes. Nothing enters the crawl budget without approval here.",

	// Chart, table and tiles
	addToChart: "Add {keyword} to the chart",
	chartNoData: "no data · {errorClass}",
	chartRank: "rank {n}",
	chartVersion: " · version {version}",
	difficultySample: "based on {n} of the top 10",
	difficultySaturation: "page saturation {pct}",
	difficultyStability: "board stability {pct}",
	difficultyTop10: "top-10 rating mass {pct}",
	difficultyTop3: "top-3 rating mass {pct}",
	hideFromChart: "Hide {keyword} from the chart",
	showOnChart: "Show {keyword} on the chart",
	allSeriesHidden: "Every line is hidden. Use the keys below to show one.",
	navSections: "Sections",
	noChangeWindow: "no change in this window",
	noFieldDiff: "no field diff",
	notInTop200: "not in top 200",
	notRanked: "not ranked",
	notRankedTitled: "{title}: not ranked (top 200)",
	opportunityPop: " · pop {n}",
	pairFallback: "Pair {id}",
	removeFromChart: "Remove {keyword} from the chart",
} as const;

/** Every locale must supply exactly the English keys, enforced at compile time. */
export type Dictionary = Record<keyof typeof en, string>;

const fr: Dictionary = {
	appStoreOptimization: "Optimisation App Store",
	collecting: "Collecte en cours",
	collection: "Collecte",
	complete: "Terminée",
	dataHealth: "État des données",
	keywordPerformance: "Performance des mots-clés",
	reviews: "Avis",
	suggestions: "Suggestions",
	today: "aujourd'hui",
	collectionError: "erreur de collecte",
	collectionErrors: "erreurs de collecte",
	application: "Application",
	language: "Langue",

	laneBlocked: "Bloqués",
	laneBlockedHint:
		"Le volume existe, mais les leaders sont installés. Il faudra plus que des métadonnées.",
	laneClose: "À portée",
	laneCloseHint:
		"À portée de la zone visible. C'est là qu'une mise à jour doit viser.",
	laneUnknown: "Sans données de volume",
	laneUnknownHint:
		"Vous êtes classé, mais Apple ne publie aucun volume pour ces termes ; jugez-les sur le rang et la difficulté.",
	laneVanity: "Rangs de vanité",
	laneVanityHint:
		"Classé là où personne ne cherche. À récupérer lors de la prochaine mise à jour.",
	laneWinning: "Gagnants",
	laneWinningHint: "Top 10 sur un terme à volume réel. À défendre.",
	whatToWorkOn: "Sur quoi travailler",
	genericProgress: "{inZone} mots-clés génériques sur {total} dans le top 10.",
	brandCounted: "{n} termes de marque comptés à part.",
	brandCountedOne: "1 terme de marque compté à part.",
	coverageNote: "Aucun volume Apple pour {n} des {total}.",

	reasonBlocked:
		"Volume réel, mais le haut de la page est verrouillé ; les métadonnées seules n'y suffiront pas.",
	reasonClose: "À portée de la zone visible, sur un terme qui a du volume.",
	reasonDormantDeep:
		"Trop bas pour générer des taps, sans indice que la remontée soit courte.",
	reasonDormantUnranked:
		"Pas classé du tout : soit les métadonnées ne couvrent pas le terme, soit il est hors d'atteinte.",
	reasonUnknownReachable:
		"Assez proche pour pousser, mais Apple ne publie aucun volume pour ce terme : le gain reste non mesuré.",
	reasonUnknownTapZone:
		"Top 10, mais Apple ne publie aucun volume de recherche pour ce terme ; une victoire et un rang de vanité sont ici indiscernables.",
	reasonVanity:
		"Classé là où presque personne ne cherche ; le créneau vaut peut-être la peine d'être récupéré.",
	reasonWinning: "Top 10 sur un terme à volume réel, à défendre.",

	anyPopularity: "Toute popularité",
	bandVeryHigh: "Très élevée (85–100)",
	bandHigh: "Élevée (60–84)",
	bandMedium: "Moyenne (20–59)",
	bandLow: "Faible (10–19)",
	bandVeryLow: "Très faible (0–9)",
	bestWorst: "Meilleur / pire",
	daysObserved: "{n} jours observés",
	dayObserved: "{n} jour observé",
	filterByPopularity: "Filtrer par popularité",
	filterKeywords: "Filtrer les mots-clés",
	filterNKeywords: "Filtrer {n} mots-clés",
	chartCaption:
		"Classement de {app} pour {n} mots-clés, du {from} au {to}. Le rang 1 est en haut. Un trou est un jour sans observation, jamais un rang stable ; les jours hors du top 200 et les jours d'échec de collecte sont sur leurs propres rails sous le graphique. Le tableau ci-dessous liste chaque mot-clé et son dernier rang.",
	keywordInsights: "Analyse du mot-clé",
	noAppTracked: "Aucune application n'est encore suivie.",
	nOfMShown: "{n} sur {total} affichés",
	pageSub: "Où {app} se classe dans la recherche App Store, jour après jour.",
	position: "Position",
	rangeDays: "{n} jours",
	reportFailed:
		"Ce rapport n'a pas pu être chargé. Consultez la page état des données.",
	searchRank: "Rang de recherche",
	searchResults: "Résultats de recherche",
	timePeriod: "Période",
	topResults: "Meilleurs résultats",
	total: "Total",
	unprovenTitle:
		"a bougé dans les dernières 48 h ; Apple rebrasse, ce rang n'est pas stabilisé",

	view: "Voir",
	contestedTitle:
		"{n} résultats de plus qu'au début de la période : le terme se dispute davantage",
	pairDetailSub:
		"Rang de {app} dans le top 200, chaque jour. Un trou est une observation manquante, pas un rang stable.",
	theTrackedApp: "l'application suivie",
	top10Presence: "Présence top 10",
	suggestionPayload: "Contenu",

	app: "Application",
	averageRank: "Rang moyen",
	beyond100: "> 100",
	classLabel: "Type",
	count: "Nombre",
	lastSeen: "Dernière fois",
	detail: "Détail",
	noErrors: "Rien à signaler. Aucune erreur enregistrée.",
	difficultyFewIncumbents: "peu de concurrents connus",
	difficultyUnscored: "pas encore évalué, nécessite une observation classée",
	rankDistribution: "Répartition des rangs",
	ranked: "Classés",
	keywordMovement: "Mouvement des mots-clés",
	top10ShareTitle:
		"part des jours observés où cette application est apparue dans le top 10",
	top10Today: "Top 10 aujourd'hui",
	top25: "Top 25",
	top5: "Top 5",
	top100: "Top 100",
	unchanged: "Stables",
	wentDown: "En baisse",
	wentUp: "En hausse",

	best: "Meilleur",
	change: "Évolution",
	difficulty: "Difficulté",
	export: "Exporter en CSV",
	keyword: "Mot-clé",
	keywords: "Mots-clés",
	loading: "Chargement…",
	popularity: "Popularité",
	results: "Résultats",
	storefront: "Boutique",
	unproven: "Non confirmé",
	worst: "Pire",

	// Data health
	ascAnomalies: "Anomalies ASC",
	ascAnomaliesNote: "dates de rapport dupliquées ou manquantes",
	budgetPending: "pas encore calculé, s'exécute avec les tâches quotidiennes",
	budgetReserved: "{n} requêtes/jour réservées aux relevés d'app.",
	collapse: "Réduire",
	healthCoverageNote: "{pct} % des paires Tier-1 observées ({date})",
	coverageToday: "Couverture du jour",
	crawlBudget: "Budget de collecte",
	crawlPaused: "en pause jusqu'à {time}",
	crawlRate: "Cadence de collecte",
	crawlRateNote: "requêtes/min, apprise",
	dailyCompleted: "terminée",
	dailyFailed: "échouée",
	dailyNoRun: "aucune exécution enregistrée",
	dailyQueuedSuffix: " · {n} en file",
	dailyUnfinished: "démarrée sans jamais se terminer",
	errorsLast24h: "Erreurs, dernières 24 h",
	expand: "Développer",
	healthIntro:
		"Mieux vaut un trou visible qu'une donnée fausse. Tout ce qui est en rouge demande de vérifier les chiffres du jour.",
	lastDailyJob: "Dernière tâche quotidienne",
	loopNeverTicked: "jamais démarrée, le collecteur n'a pas tourné",
	loopQueued: "{n} en file",
	loopQueueEmpty: "file vide",
	loopSinceTick: "depuis le dernier passage",
	overdueNote: "en retard de plus d'un intervalle",
	overduePairs: "Paires en retard",
	throttleHits: "Limitations (24 h)",
	throttleNote: "403/429 renvoyés par Apple",
	workLoop: "Boucle de collecte",

	// Result page drawer
	appFallback: "App {id}",
	close: "Fermer",
	drawerFailed: "Impossible de charger la page de résultats.",
	drawerObserved: "observé le {date}",
	drawerResultCount: "{n} résultats",
	drawerSearchResults: "Résultats de recherche pour {keyword}",

	// Reviews
	reviewsEmpty:
		"Rien de collecté pour l'instant. Le relevé quotidien s'en charge.",
	reviewsIntro:
		"Avis les plus récents, toutes boutiques confondues. Le flux d'Apple s'arrête aux 500 derniers par boutique.",
	starsLabel: "{n} étoiles",
	noCompetitorData: "Aucune donnée sur les concurrents pour l'instant.",
	noKeywordMatch: "Aucun mot-clé ne correspond à « {filter} ».",
	noRankedObservations:
		"Aucune observation classée sur cette période. Le collecteur la remplit chaque jour.",
	suggestionsEmpty: "Boîte vide. Le balayage du marché mondial la remplit.",
	suggestionsIntro:
		"Promotions proposées par le balayage mondial. Rien n'entre dans le budget de collecte sans validation ici.",

	// Chart, table and tiles
	addToChart: "Ajouter {keyword} au graphique",
	chartNoData: "aucune donnée · {errorClass}",
	chartRank: "rang {n}",
	chartVersion: " · version {version}",
	difficultySample: "d'après {n} des 10 premiers",
	difficultySaturation: "saturation de la page {pct}",
	difficultyStability: "stabilité du classement {pct}",
	difficultyTop10: "poids des notes du top 10 {pct}",
	difficultyTop3: "poids des notes du top 3 {pct}",
	hideFromChart: "Masquer {keyword} du graphique",
	showOnChart: "Afficher {keyword} sur le graphique",
	allSeriesHidden:
		"Toutes les courbes sont masquées. Utilisez la légende pour en afficher une.",
	navSections: "Sections",
	noChangeWindow: "aucun changement sur la période",
	noFieldDiff: "aucun champ modifié",
	notInTop200: "hors du top 200",
	notRanked: "non classé",
	notRankedTitled: "{title} : non classé (top 200)",
	opportunityPop: " · pop {n}",
	pairFallback: "Paire {id}",
	removeFromChart: "Retirer {keyword} du graphique",
};

const DICTIONARIES: Record<Lang, Dictionary> = { en, fr };

export const LANGUAGES: { code: Lang; label: string }[] = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
];

/**
 * The stored choice, else the browser's own preference, else English. Reading
 * localStorage throws outright in some privacy modes, so it is guarded rather
 * than assumed.
 */
export function initialLang(): Lang {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "en" || stored === "fr") {
			return stored;
		}
	} catch {
		// Storage unavailable; fall through to the browser preference.
	}
	return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

interface I18n {
	lang: Lang;
	setLang: (lang: Lang) => void;
	t: Dictionary;
}

const I18nContext = createContext<I18n>({
	lang: "en",
	setLang: () => {
		// Replaced by the provider; the default keeps `useT` safe outside one.
	},
	t: en,
});

export function I18nProvider({ children }: { children: ReactNode }) {
	const [lang, setLang] = useState<Lang>(initialLang);

	useEffect(() => {
		document.documentElement.lang = lang;
		try {
			localStorage.setItem(STORAGE_KEY, lang);
		} catch {
			// A preference we cannot persist is still worth honouring this session.
		}
	}, [lang]);

	const value = useMemo(
		() => ({ lang, setLang, t: DICTIONARIES[lang] }),
		[lang]
	);
	return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
	return useContext(I18nContext);
}

/** Fill `{name}` placeholders. Deliberately tiny: no plural rules, no ICU. */
export function fmt(
	template: string,
	values: Record<string, string | number>
): string {
	return template.replaceAll(/\{(?<name>\w+)\}/gu, (whole, name: string) =>
		name in values ? String(values[name]) : whole
	);
}

/**
 * Pick the singular or plural key. English and French agree on the only rule
 * this product needs (0 and 2+ take the plural, 1 does not), so a full
 * plural-rules engine would be machinery for a branch.
 */
export function plural(
	t: Dictionary,
	n: number,
	one: keyof Dictionary,
	many: keyof Dictionary
): string {
	return fmt(n === 1 ? t[one] : t[many], { n });
}

/** Shorthand for the common case of needing only the strings. */
export function useT(): Dictionary {
	return useContext(I18nContext).t;
}

const REASON_KEYS = {
	blocked: "reasonBlocked",
	close: "reasonClose",
	dormantDeep: "reasonDormantDeep",
	dormantUnranked: "reasonDormantUnranked",
	unknownReachable: "reasonUnknownReachable",
	unknownTapZone: "reasonUnknownTapZone",
	vanity: "reasonVanity",
	winning: "reasonWinning",
} as const satisfies Record<string, keyof Dictionary>;

/**
 * Translate a verdict. Falls back to the API's English prose for a key this
 * build does not know. A new server verdict should read oddly, never vanish.
 */
export function reasonText(
	t: Dictionary,
	reasonKey: string | undefined,
	fallback: string
): string {
	const key = REASON_KEYS[reasonKey as keyof typeof REASON_KEYS];
	return key ? t[key] : fallback;
}

export function LanguagePicker() {
	const { lang, setLang, t } = useI18n();
	return (
		<Select
			hiddenLabel
			label={t.language}
			onValueChange={(next) => setLang(next as Lang)}
			options={LANGUAGES.map((l) => ({ label: l.label, value: l.code }))}
			tone="quiet"
			value={lang}
		/>
	);
}
