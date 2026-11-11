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

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { ReactNode } from "react";

import { Select } from "./components/select";
import { cached, PREF_LANG, savePreference, setCached } from "./preferences";

export type Lang = "en" | "fr";

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
	// One crawl pair is one keyword looked up in one storefront, so the count is
	// searches performed, not keywords tracked: 129 keywords across three
	// storefronts is 387 searches. A bare "387/387" left the reader guessing
	// which of the two it meant.
	searchesToday: "{done} of {total} searches today",
	lostAria: "{n} observations lost in the last 24 hours",
	lostAriaOne: "{n} observation lost in the last 24 hours",
	appsFailed: "The app list could not be loaded. Reload the page to try again.",
	loadFailed: "This could not be loaded. Reload the page to try again.",
	lostCount: "{n} lost",
	markSeen: "Mark as seen",
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
	genericProgress:
		"You are in the top 10 for {inZone} of your {total} generic keywords.",
	brandCounted:
		"{n} brand terms (people searching your own name) are counted separately.",
	brandCountedOne:
		"1 brand term (people searching your own name) is counted separately.",
	coverageNote:
		"Apple published no volume for {n} of the {total} when we asked, so those are judged on rank and difficulty alone.",
	coveragePending:
		"{n} of the {total} have not been through a popularity pull yet, so their volume is unknown rather than absent.",

	// Verdict reasons, keyed to the server's ReasonKey.
	reasonBlocked:
		"Real volume, but the top of the page is entrenched, so metadata alone will not win it.",
	reasonClose: "Within reach of the visible zone on a term that has volume.",
	reasonDormantDeep:
		"Too far down to earn taps, with no evidence the climb is short.",
	reasonDormantUnranked:
		"Not ranking at all: either the metadata does not cover it or the term is out of reach.",
	reasonNoObservation:
		"No observation in this period yet, so there is no verdict: this is missing data, not a rank.",
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
	bestWorst: "Best / worst rank",
	daysObserved: "{n} days observed",
	dayObserved: "{n} day observed",
	filterByPopularity: "Filter by popularity",
	chartCaption:
		"Rank of {app} for {keywords}, {from} to {to}. Rank 1 is at the top. A gap is a day with no observation, never a flat rank; days outside the top 200 and days the fetch failed sit on their own rails below the plot. Every keyword and its latest rank are listed in the table below.",
	filterKeywords: "Filter keywords",
	filterNKeywords: "Filter {n} keywords",
	filterOneKeyword: "Filter {n} keyword",
	nKeywords: "{n} keywords",
	nKeyword: "{n} keyword",
	nDays: "{n} days",
	nDay: "{n} day",
	storefrontsEmpty: "No keyword is tracked for this app in any storefront yet.",
	storefrontsFailed:
		"The storefront list could not be loaded. Reload the page to try again.",
	// The two ways a row can have no rank to show without that being a rank.
	// Kept apart from the dash, which says "observed, outside the top 200".
	cellNoData: "no data",
	cellNoDataTitle:
		"Not observed yet in this period. This is missing data, not a rank.",
	cellFailed: "failed",
	cellFailedTitle:
		"Every collection attempt in this period failed. This is missing data, not a rank.",
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
	total: "Total apps",
	unprovenTitle:
		"This rank moved in the last 48 hours. Apple reshuffles, so it has not settled.",

	// Tiles, drawer, secondary pages
	app: "App",
	averageRank: "Average rank",
	beyond100: "101+",
	classLabel: "Class",
	count: "Count",
	lastSeen: "Last seen",
	detail: "Detail",
	noErrors: "Clean. No errors recorded.",
	difficultyFewIncumbents:
		"Fewer than 5 of the top 10 have known ratings, so this score is a rough estimate.",
	difficultyUnscored: "Not scored yet: this needs a ranked observation first.",
	rankDistribution: "Rank distribution",
	ranked: "Keywords ranked",
	keywordMovement: "Keyword movement",
	top10ShareTitle: "share of observed days this app appeared in the top 10",
	top10Today: "Top 10 today",
	top25: "6–25",
	top5: "1–5",
	top100: "26–100",
	unchanged: "Unchanged",
	wentDown: "Went down",
	wentUp: "Went up",

	// Table & filters
	view: "View",
	contested: "More contested",
	contestedTitle:
		"{n} more results than at the start of the window, so the term is getting more contested.",
	pairDetailSub:
		"Rank of {app} in the top 200, daily. Gaps are missing observations, not flat ranks.",
	theTrackedApp: "the tracked app",
	top10Presence: "Top-10 presence",
	suggestionPayload: "Payload",
	suggestionWhy: "Apple suggests this alongside {seed}, in {storefront}.",
	trackKeyword: "Track it",
	dismiss: "Dismiss",
	best: "Best rank",
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
	worst: "Worst rank",

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
	dailyStale: "no run in the last 26 hours",
	dailyQueuedSuffix: " · queued {n}",
	dailyUnfinished: "started and never finished",
	errorsLast24h: "Errors, last 24h",
	errorsWhere: "Where",
	errorsCostNote: "cost data",
	// The closed vocabulary from fetch_error.error_class, in words. The raw
	// values are precise and mean nothing to a reader.
	errThrottled: "Rate-limited by Apple",
	errRateLimited: "Rate-limited by Apple",
	errHttpError: "Apple returned an error",
	errInvalidBody: "Unreadable response",
	errDoRestarted: "The collector was redeployed mid-step",
	errUpstreamError: "Apple reported a failure",
	errTaskThrew: "The task failed",
	errAppNotInStorefront: "Not sold in this storefront",
	errSkippedProcessingDate: "Apple skipped a report day",
	errDuplicateProcessingDate: "Apple delivered a report day twice",
	errStoppedDueToInactivity: "Apple stopped an unpolled report",
	errPullAbandoned: "A feed gave up today",
	errUnclassified: "Unclassified error",
	expand: "Expand",
	healthIntro:
		"Visible gaps beat silent garbage. Anything red here means today's numbers need a second look.",
	lastDailyJob: "Last daily job",
	loopNeverTicked: "never ticked, the collector has not run",
	loopQueued: "{n} queued",
	loopIdle: "idle, nothing queued",
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
	drawerNoObservation: "no observation yet",
	drawerResultCount: "{n} results",
	drawerResultCountOne: "{n} result",
	drawerSearchResults: "Search results for {keyword}",

	// Reviews
	reviewVersion: "Version {version}",
	reviewsEmpty: "Nothing collected yet. The daily pull fills this in.",
	reviewsIntro:
		"Most recent reviews across storefronts. Apple's feed caps at the latest 500 per storefront.",
	starsLabel: "{n} stars",
	starLabel: "{n} star",
	starsUnrated: "Not rated",
	noCompetitorData: "No competitor data yet.",
	noKeywordMatch: "No keywords match “{filter}”.",
	noKeywordInBand: "No keywords in this popularity band.",
	noRankedObservations:
		"No ranked observations in this window yet. The collector fills this in daily.",
	suggestionsEmpty:
		"Nothing pending. Discovery runs every Monday and proposes only keywords you do not already track.",
	suggestionsIntro:
		"Keywords Apple associates with the ones you already track. Nothing enters the crawl budget without approval here.",

	// Chart, table and tiles
	chartAria:
		"Rank history for {keywords} over {days}, {from} to {to}. Rank 1 is at the top; gaps are days with no observation.",
	// One constant name per toggle, with the state in aria-pressed. A name that
	// flips with the state ("Hide X", pressed) reads as a double negative.
	chartMember: "{keyword} on the chart",
	chartNoData: "no data · {errorClass}",
	chartRank: "rank {n}",
	chartVersion: " · version {version}",
	difficultySample: "based on {n} of the top 10",
	difficultySaturation: "page saturation {pct}",
	difficultyStability: "board stability {pct}",
	difficultyTop10: "top-10 rating mass {pct}",
	difficultyTop3: "top-3 rating mass {pct}",
	showOnChart: "Show {keyword} on the chart",
	allSeriesHidden: "Every line is hidden. Use the keys below to show one.",
	noKeywordSelected:
		"No keyword is on the chart. Tick one in the table below to draw it.",
	railUnranked: ">200",
	railError: "error",
	railUnrankedTitle: "{date}: {keyword} observed, outside the top 200",
	railErrorTitle:
		"{date}: {keyword} fetch failed ({errorClass}), not a rank change",
	deltaUp: "up",
	deltaDown: "down",
	deltaAge: "{n}d",
	meterNoData: "{label}: no data",
	minutesShort: "{n}m",
	// The fields a release can change, as the report names them.
	fieldTitle: "title",
	fieldSubtitle: "subtitle",
	fieldVersion: "version",
	fieldPrice: "price",
	fieldHasIap: "in-app purchases",
	fieldDescription: "description",
	fieldReleaseNotes: "release notes",
	fieldScreenshots: "screenshots",
	fieldIcon: "icon",
	fieldFirstSeen: "first seen",
	navSections: "Sections",
	noChangeWindow: "no change in this window",
	noFieldDiff: "no field diff",
	notInTop200: "not in top 200",
	opportunityPop: " · pop {n}",
	pairFallback: "Pair {id}",

	// Explanations. Every number here is derived from something the reader
	// cannot see, so each one owns a sentence saying what it is and what it is
	// not. They live behind a focusable trigger rather than a `title`, which
	// touch and the keyboard never reach.
	explainAbout: "About {label}",
	helpPosition:
		"Where this app ranks in App Store search for the keyword, on the most recent day collected. A dash means it was observed outside the top 200 that day. “No data” means it was not observed in this period, and “failed” that every collection attempt failed: neither is a rank.",
	helpChange:
		"How far the rank moved against its previous different rank in this period, and how long ago that was. Up means closer to rank 1.",
	helpPopularity:
		"Apple's own search popularity for the term, 0 to 100, on a curve rather than a count of searches. Below 5 there is no measurable volume; 30 and above is a head term. Apple publishes none for many keywords, and a dash there means no data, not zero.",
	helpDifficulty:
		"How hard it looks to reach the top 10 for this term, 0 (open) to 100 (very hard). This is our own estimate, built from the ratings of the apps already there, how much the top of the page moves, and how full it is. Above 80, metadata alone will not move it.",
	helpBestWorst:
		"The best and the worst rank this keyword held during the selected period.",
	helpTotalApps:
		"How many apps Apple returns for this search. The larger the number, the more crowded the term.",
	helpTopResults:
		"The apps holding the first places for this term. Open the list to see the whole result page.",
	helpAverageRank:
		"The mean rank across the keywords that are ranking now. A rough gauge only: one dead keyword moves it more than a real win does, so read the distribution beside it first.",
	helpDistribution:
		"Where the ranking keywords sit today. Only keywords with a rank in this period are counted.",
	helpMovement:
		"How many keywords rose, fell, or held still in this period, each measured against its own previous different rank.",
	rankedOf: "{n} of {total}",
	movementPeriod: "Against each keyword's previous rank, over {n} days.",
	chartCapacity: "{n} of {max} keywords on the chart",
	chartFull:
		"The chart holds {max} keywords at once. Uncheck one to add another.",
	popularityTitle: "Search popularity {n} of 100 — {band}.",
	popularityNone: "Apple publishes no search popularity for this keyword.",
	difficultyTitle: "Difficulty {n} of 100 — {band}.",
	diffVeryHard: "very hard",
	diffHard: "hard",
	diffModerate: "moderate",
	diffReachable: "reachable",
	diffOpen: "open",
	averageRankNote: "Across the keywords that ranked in the last {n} days.",
	distributionBucket: "{count} keywords at rank {label}",
	distributionBucketOne: "{count} keyword at rank {label}",
	distributionNote: "Each keyword's most recent rank in this period.",
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
	searchesToday: "{done} sur {total} recherches aujourd'hui",
	lostAria: "{n} observations perdues ces dernières 24 h",
	lostAriaOne: "{n} observation perdue ces dernières 24 h",
	appsFailed:
		"La liste des applications n'a pas pu être chargée. Rechargez la page pour réessayer.",
	loadFailed: "Le chargement a échoué. Rechargez la page pour réessayer.",
	lostCount: "{n} perdues",
	markSeen: "Marquer comme vu",
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
	genericProgress:
		"Vous êtes dans le top 10 pour {inZone} de vos {total} mots-clés génériques.",
	brandCounted:
		"{n} termes de marque (les recherches de votre propre nom) sont comptés à part.",
	brandCountedOne:
		"1 terme de marque (les recherches de votre propre nom) est compté à part.",
	coverageNote:
		"Apple n'a publié aucun volume pour {n} des {total} au moment de la requête ; ceux-là se jugent au rang et à la difficulté.",
	coveragePending:
		"{n} des {total} n'ont pas encore fait l'objet d'un relevé de popularité : leur volume est inconnu, pas absent.",

	reasonBlocked:
		"Volume réel, mais le haut de la page est verrouillé ; les métadonnées seules n'y suffiront pas.",
	reasonClose: "À portée de la zone visible, sur un terme qui a du volume.",
	reasonDormantDeep:
		"Trop bas pour générer des taps, sans indice que la remontée soit courte.",
	reasonDormantUnranked:
		"Pas classé du tout : soit les métadonnées ne couvrent pas le terme, soit il est hors d'atteinte.",
	reasonNoObservation:
		"Aucune observation sur cette période, donc aucun verdict : c'est une donnée manquante, pas un rang.",
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
	bestWorst: "Meilleur / pire rang",
	daysObserved: "{n} jours observés",
	dayObserved: "{n} jour observé",
	filterByPopularity: "Filtrer par popularité",
	filterKeywords: "Filtrer les mots-clés",
	filterNKeywords: "Filtrer {n} mots-clés",
	filterOneKeyword: "Filtrer {n} mot-clé",
	nKeywords: "{n} mots-clés",
	nKeyword: "{n} mot-clé",
	nDays: "{n} jours",
	nDay: "{n} jour",
	storefrontsEmpty:
		"Aucun mot-clé n'est encore suivi pour cette application, dans aucune boutique.",
	storefrontsFailed:
		"La liste des boutiques n'a pas pu être chargée. Rechargez la page pour réessayer.",
	cellNoData: "sans donnée",
	cellNoDataTitle:
		"Pas encore observé sur cette période. C'est une donnée manquante, pas un rang.",
	cellFailed: "échec",
	cellFailedTitle:
		"Toutes les tentatives de collecte de cette période ont échoué. C'est une donnée manquante, pas un rang.",
	chartCaption:
		"Classement de {app} pour {keywords}, du {from} au {to}. Le rang 1 est en haut. Un trou est un jour sans observation, jamais un rang stable ; les jours hors du top 200 et les jours d'échec de collecte sont sur leurs propres rails sous le graphique. Le tableau ci-dessous liste chaque mot-clé et son dernier rang.",
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
	total: "Total d’apps",
	unprovenTitle:
		"Ce rang a bougé dans les dernières 48 h. Apple rebrasse, il n'est pas stabilisé.",

	view: "Voir",
	contested: "Plus disputé",
	contestedTitle:
		"{n} résultats de plus qu'au début de la période : le terme se dispute davantage.",
	pairDetailSub:
		"Rang de {app} dans le top 200, chaque jour. Un trou est une observation manquante, pas un rang stable.",
	theTrackedApp: "l'application suivie",
	top10Presence: "Présence top 10",
	suggestionPayload: "Contenu",
	suggestionWhy: "Apple le propose à côté de {seed}, sur {storefront}.",
	trackKeyword: "Suivre",
	dismiss: "Ignorer",

	app: "Application",
	averageRank: "Rang moyen",
	beyond100: "101+",
	classLabel: "Type",
	count: "Nombre",
	lastSeen: "Dernière fois",
	detail: "Détail",
	noErrors: "Rien à signaler. Aucune erreur enregistrée.",
	difficultyFewIncumbents:
		"Moins de 5 apps du top 10 ont des notes connues : ce score reste une estimation grossière.",
	difficultyUnscored:
		"Pas encore évalué : il faut d’abord une observation classée.",
	rankDistribution: "Répartition des rangs",
	ranked: "Mots-clés classés",
	keywordMovement: "Mouvement des mots-clés",
	top10ShareTitle:
		"part des jours observés où cette application est apparue dans le top 10",
	top10Today: "Top 10 aujourd'hui",
	top25: "6–25",
	top5: "1–5",
	top100: "26–100",
	unchanged: "Stables",
	wentDown: "En baisse",
	wentUp: "En hausse",

	best: "Meilleur rang",
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
	worst: "Pire rang",

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
	dailyStale: "aucune exécution depuis 26 heures",
	dailyQueuedSuffix: " · {n} en file",
	dailyUnfinished: "démarrée sans jamais se terminer",
	errorsLast24h: "Erreurs, dernières 24 h",
	errorsWhere: "Où",
	errorsCostNote: "données perdues",
	errThrottled: "Limité par Apple",
	errRateLimited: "Limité par Apple",
	errHttpError: "Erreur renvoyée par Apple",
	errInvalidBody: "Réponse illisible",
	errDoRestarted: "Le collecteur a été redéployé en cours d'étape",
	errUpstreamError: "Apple a signalé un échec",
	errTaskThrew: "La tâche a échoué",
	errAppNotInStorefront: "Non vendue dans cette boutique",
	errSkippedProcessingDate: "Apple a sauté un jour de rapport",
	errDuplicateProcessingDate: "Apple a livré un jour de rapport en double",
	errStoppedDueToInactivity: "Apple a arrêté un rapport non consulté",
	errPullAbandoned: "Un flux a abandonné",
	errUnclassified: "Erreur non classée",
	expand: "Développer",
	healthIntro:
		"Mieux vaut un trou visible qu'une donnée fausse. Tout ce qui est en rouge demande de vérifier les chiffres du jour.",
	lastDailyJob: "Dernière tâche quotidienne",
	loopNeverTicked: "jamais démarrée, le collecteur n'a pas tourné",
	loopQueued: "{n} en file",
	loopIdle: "au repos, rien en file",
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
	drawerNoObservation: "pas encore d'observation",
	drawerResultCount: "{n} résultats",
	drawerResultCountOne: "{n} résultat",
	drawerSearchResults: "Résultats de recherche pour {keyword}",

	// Reviews
	reviewVersion: "Version {version}",
	reviewsEmpty:
		"Rien de collecté pour l'instant. Le relevé quotidien s'en charge.",
	reviewsIntro:
		"Avis les plus récents, toutes boutiques confondues. Le flux d'Apple s'arrête aux 500 derniers par boutique.",
	starsLabel: "{n} étoiles",
	starLabel: "{n} étoile",
	starsUnrated: "Sans note",
	noCompetitorData: "Aucune donnée sur les concurrents pour l'instant.",
	noKeywordMatch: "Aucun mot-clé ne correspond à « {filter} ».",
	noKeywordInBand: "Aucun mot-clé dans cette tranche de popularité.",
	noRankedObservations:
		"Aucune observation classée sur cette période. Le collecteur la remplit chaque jour.",
	suggestionsEmpty:
		"Rien en attente. La découverte tourne chaque lundi et ne propose que des mots-clés non suivis.",
	suggestionsIntro:
		"Mots-clés qu'Apple associe à ceux que vous suivez déjà. Rien n'entre dans le budget de collecte sans validation ici.",

	// Chart, table and tiles
	chartAria:
		"Historique du rang pour {keywords} sur {days}, du {from} au {to}. Le rang 1 est en haut ; un trou est un jour sans observation.",
	chartMember: "{keyword} sur le graphique",
	chartNoData: "aucune donnée · {errorClass}",
	chartRank: "rang {n}",
	chartVersion: " · version {version}",
	difficultySample: "d'après {n} des 10 premiers",
	difficultySaturation: "saturation de la page {pct}",
	difficultyStability: "stabilité du classement {pct}",
	difficultyTop10: "poids des notes du top 10 {pct}",
	difficultyTop3: "poids des notes du top 3 {pct}",
	showOnChart: "Afficher {keyword} sur le graphique",
	allSeriesHidden:
		"Toutes les courbes sont masquées. Utilisez la légende pour en afficher une.",
	noKeywordSelected:
		"Aucun mot-clé n'est sur le graphique. Cochez-en un dans le tableau ci-dessous pour le tracer.",
	railUnranked: ">200",
	railError: "échec",
	railUnrankedTitle: "{date} : {keyword} observé, hors du top 200",
	railErrorTitle:
		"{date} : échec de collecte pour {keyword} ({errorClass}), pas un changement de rang",
	deltaUp: "en hausse",
	deltaDown: "en baisse",
	deltaAge: "{n} j",
	meterNoData: "{label} : aucune donnée",
	minutesShort: "{n} min",
	fieldTitle: "titre",
	fieldSubtitle: "sous-titre",
	fieldVersion: "version",
	fieldPrice: "prix",
	fieldHasIap: "achats intégrés",
	fieldDescription: "description",
	fieldReleaseNotes: "notes de version",
	fieldScreenshots: "captures d'écran",
	fieldIcon: "icône",
	fieldFirstSeen: "première observation",
	navSections: "Sections",
	noChangeWindow: "aucun changement sur la période",
	noFieldDiff: "aucun champ modifié",
	notInTop200: "hors du top 200",
	opportunityPop: " · pop {n}",
	pairFallback: "Paire {id}",

	explainAbout: "À propos de {label}",
	helpPosition:
		"Le rang de cette app dans la recherche App Store pour ce mot-clé, au dernier jour collecté. Un tiret signifie qu'elle a été observée hors du top 200 ce jour-là. « Sans donnée » signifie qu'elle n'a pas été observée sur la période, et « échec » que toutes les tentatives de collecte ont échoué : ni l'un ni l'autre n'est un rang.",
	helpChange:
		"L'écart entre ce rang et le rang différent précédent de la période, et son ancienneté. Une hausse rapproche du rang 1.",
	helpPopularity:
		"La popularité de recherche publiée par Apple pour ce terme, de 0 à 100, sur une courbe et non en nombre de recherches. En dessous de 5, le volume n'est pas mesurable ; à partir de 30, c'est un terme majeur. Apple n'en publie pas pour beaucoup de mots-clés : un tiret veut dire « aucune donnée », pas zéro.",
	helpDifficulty:
		"La difficulté estimée pour atteindre le top 10 de ce terme, de 0 (ouvert) à 100 (très difficile). C'est notre propre estimation, calculée à partir des notes des apps déjà en place, de la stabilité du haut de page et de son remplissage. Au-dessus de 80, les métadonnées seules n'y suffiront pas.",
	helpBestWorst:
		"Le meilleur et le pire rang tenus par ce mot-clé sur la période choisie.",
	helpTotalApps:
		"Le nombre d'apps qu'Apple renvoie pour cette recherche. Plus il est grand, plus le terme est disputé.",
	helpTopResults:
		"Les apps qui occupent les premières places sur ce terme. Ouvrez la liste pour voir toute la page de résultats.",
	helpAverageRank:
		"La moyenne des rangs des mots-clés actuellement classés. Un repère grossier seulement : un mot-clé mort la déplace plus qu'une vraie victoire, lisez d'abord la répartition à côté.",
	helpDistribution:
		"Où se situent aujourd'hui les mots-clés classés. Seuls ceux ayant un rang sur la période sont comptés.",
	helpMovement:
		"Combien de mots-clés ont monté, baissé ou n'ont pas bougé sur la période, chacun par rapport à son rang différent précédent.",
	rankedOf: "{n} sur {total}",
	movementPeriod:
		"Par rapport au rang précédent de chaque mot-clé, sur {n} jours.",
	chartCapacity: "{n} sur {max} mots-clés affichés",
	chartFull:
		"Le graphique affiche {max} mots-clés à la fois. Décochez-en un pour en ajouter un autre.",
	popularityTitle: "Popularité de recherche {n} sur 100 — {band}.",
	popularityNone:
		"Apple ne publie aucune popularité de recherche pour ce mot-clé.",
	difficultyTitle: "Difficulté {n} sur 100 — {band}.",
	diffVeryHard: "très difficile",
	diffHard: "difficile",
	diffModerate: "modérée",
	diffReachable: "accessible",
	diffOpen: "ouverte",
	averageRankNote: "Sur les mots-clés classés ces {n} derniers jours.",
	distributionBucket: "{count} mots-clés au rang {label}",
	distributionBucketOne: "{count} mot-clé au rang {label}",
	distributionNote: "Le dernier rang connu de chaque mot-clé sur la période.",
};

const DICTIONARIES: Record<Lang, Dictionary> = { en, fr };

const LANGUAGES: { code: Lang; label: string }[] = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
];

/**
 * The cached choice, else the browser's own preference, else English.
 *
 * The cache and not the database, because this decides which language the first
 * frame renders in and a round trip would paint the wrong one first. The shell
 * reconciles with the stored preference once it has it.
 */
export function initialLang(): Lang {
	const stored = cached(PREF_LANG);
	if (stored === "en" || stored === "fr") {
		return stored;
	}
	return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

interface I18n {
	lang: Lang;
	/** The reader picked a language: applied, cached and stored server-side. */
	chooseLang: (lang: Lang) => void;
	/** The stored preference arrived: applied and cached, never written back. */
	adoptLang: (lang: Lang) => void;
	t: Dictionary;
}

const noop = () => {
	// Replaced by the provider; the default keeps `useT` safe outside one.
};

const I18nContext = createContext<I18n>({
	adoptLang: noop,
	chooseLang: noop,
	lang: "en",
	t: en,
});

export function I18nProvider({ children }: { children: ReactNode }) {
	const [lang, setLang] = useState<Lang>(initialLang);

	useEffect(() => {
		document.documentElement.lang = lang;
	}, [lang]);

	// Only a choice the reader made is written to the server. Persisting the
	// first frame's language, which is merely the browser's guess, would race
	// the shell's read of the stored preference and overwrite the reader's real
	// choice from another machine with it.
	const chooseLang = useCallback((next: Lang) => {
		setLang(next);
		savePreference(PREF_LANG, next);
	}, []);
	const adoptLang = useCallback((next: Lang) => {
		setLang(next);
		setCached(PREF_LANG, next);
	}, []);

	const value = useMemo(
		() => ({ adoptLang, chooseLang, lang, t: DICTIONARIES[lang] }),
		[adoptLang, chooseLang, lang]
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
 * Pick the singular or plural key. The two languages differ only at zero:
 * English says "0 days", French (CLDR's "one" category covers 0 and 1) says
 * "0 jour". Counts here are whole numbers, so that one difference is the whole
 * rule and a plural-rules engine would be machinery for a branch.
 */
export function plural(
	t: Dictionary,
	n: number,
	one: keyof Dictionary,
	many: keyof Dictionary
): string {
	const singular = n === 1 || (n === 0 && t === DICTIONARIES.fr);
	return fmt(singular ? t[one] : t[many], { n });
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
	noObservation: "reasonNoObservation",
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
	const { chooseLang, lang, t } = useI18n();
	return (
		<Select
			hiddenLabel
			label={t.language}
			onValueChange={(next) => chooseLang(next as Lang)}
			options={LANGUAGES.map((l) => ({ label: l.label, value: l.code }))}
			tone="quiet"
			value={lang}
		/>
	);
}

const FIELD_KEYS = {
	description: "fieldDescription",
	firstSeen: "fieldFirstSeen",
	hasIap: "fieldHasIap",
	icon: "fieldIcon",
	price: "fieldPrice",
	releaseNotes: "fieldReleaseNotes",
	screenshots: "fieldScreenshots",
	subtitle: "fieldSubtitle",
	title: "fieldTitle",
	version: "fieldVersion",
} as const satisfies Record<string, keyof Dictionary>;

/**
 * The fields a release changed, in words. The server sends its own identifiers
 * ("releaseNotes", "hasIap"); one this build does not know is shown as sent,
 * for the same reason an unknown verdict is: odd beats missing.
 */
export function changedFields(t: Dictionary, changed: string[]): string {
	return changed
		.map((field) => {
			const key = FIELD_KEYS[field as keyof typeof FIELD_KEYS];
			return key ? t[key] : field;
		})
		.join(", ");
}
