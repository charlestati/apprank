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
  language: "Language",

  // Opportunity lanes
  laneBlocked: "Blocked",
  laneBlockedHint:
    "Volume exists, but the leaders are entrenched — needs more than metadata.",
  laneClose: "Within reach",
  laneCloseHint:
    "Within reach of the visible zone. This is where a release should aim.",
  laneUnknown: "No volume data",
  laneUnknownHint:
    "Ranking, but Apple publishes no volume for these terms — judge them on rank and difficulty.",
  laneVanity: "Vanity ranks",
  laneVanityHint:
    "Ranked where nobody searches. Candidates to reclaim at the next release.",
  laneWinning: "Winning",
  laneWinningHint: "Top 10 on a term with real volume. Defend these.",
  whatToWorkOn: "What to work on",
  genericProgress:
    "{inZone} of {total} generic keywords are in the top 10 — the honest read on ASO progress.",
  brandCounted:
    "{n} brand terms are counted separately, since that demand is already yours.",
  brandCountedOne:
    "1 brand term is counted separately, since that demand is already yours.",
  coverageNote:
    "Apple publishes no search volume for {n} of {total} tracked keywords, so those are judged on rank and difficulty alone — absent from Apple's list is not the same as unsearched.",

  // Verdict reasons — keyed to the server's ReasonKey.
  reasonBlocked:
    "Real volume, but the top of the page is entrenched — metadata alone will not win it.",
  reasonClose: "Within reach of the visible zone on a term that has volume.",
  reasonDormantDeep:
    "Too far down to earn taps, with no evidence the climb is short.",
  reasonDormantUnranked:
    "Not ranking at all — either the metadata does not cover it or the term is out of reach.",
  reasonUnknownReachable:
    "Close enough to push, but Apple publishes no volume for this term, so the payoff is unmeasured.",
  reasonUnknownTapZone:
    "Top 10, but Apple publishes no search volume for this term — a win and a vanity rank look identical here.",
  reasonVanity:
    "Ranked where almost nobody searches; the slot may be worth reclaiming.",
  reasonWinning: "Top 10 on a term with real volume — defend it.",

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
    "moved in the last 48h — Apple reshuffles, so this has not settled",

  // Tiles, drawer, secondary pages
  app: "App",
  averageRank: "Average rank",
  beyond100: "> 100",
  classLabel: "Class",
  count: "Count",
  lastSeen: "Last seen",
  detail: "Detail",
  noErrors: "Clean — no errors recorded.",
  difficultyFewIncumbents: "few known incumbents",
  difficultyUnscored: "not scored yet — needs a ranked observation",
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
} as const;

/** Every locale must supply exactly the English keys — enforced at compile time. */
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
  language: "Langue",

  laneBlocked: "Bloqués",
  laneBlockedHint:
    "Le volume existe, mais les leaders sont installés — il faudra plus que des métadonnées.",
  laneClose: "À portée",
  laneCloseHint:
    "À portée de la zone visible. C'est là qu'une mise à jour doit viser.",
  laneUnknown: "Sans données de volume",
  laneUnknownHint:
    "Vous êtes classé, mais Apple ne publie aucun volume pour ces termes — jugez-les sur le rang et la difficulté.",
  laneVanity: "Rangs de vanité",
  laneVanityHint:
    "Classé là où personne ne cherche. À récupérer lors de la prochaine mise à jour.",
  laneWinning: "Gagnants",
  laneWinningHint: "Top 10 sur un terme à volume réel. À défendre.",
  whatToWorkOn: "Sur quoi travailler",
  genericProgress:
    "{inZone} mots-clés génériques sur {total} sont dans le top 10 — la lecture honnête de la progression ASO.",
  brandCounted:
    "{n} termes de marque sont comptés à part, puisque cette demande vous appartient déjà.",
  brandCountedOne:
    "1 terme de marque est compté à part, puisque cette demande vous appartient déjà.",
  coverageNote:
    "Apple ne publie aucun volume de recherche pour {n} des {total} mots-clés suivis ; ils sont donc jugés sur le rang et la difficulté seuls — absent de la liste d'Apple ne veut pas dire sans recherches.",

  reasonBlocked:
    "Volume réel, mais le haut de la page est verrouillé — les métadonnées seules n'y suffiront pas.",
  reasonClose: "À portée de la zone visible, sur un terme qui a du volume.",
  reasonDormantDeep:
    "Trop bas pour générer des taps, sans indice que la remontée soit courte.",
  reasonDormantUnranked:
    "Pas classé du tout — soit les métadonnées ne couvrent pas le terme, soit il est hors d'atteinte.",
  reasonUnknownReachable:
    "Assez proche pour pousser, mais Apple ne publie aucun volume pour ce terme : le gain reste non mesuré.",
  reasonUnknownTapZone:
    "Top 10, mais Apple ne publie aucun volume de recherche pour ce terme — une victoire et un rang de vanité sont ici indiscernables.",
  reasonVanity:
    "Classé là où presque personne ne cherche ; le créneau vaut peut-être la peine d'être récupéré.",
  reasonWinning: "Top 10 sur un terme à volume réel — à défendre.",

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
    "a bougé dans les dernières 48 h — Apple rebrasse, ce rang n'est pas stabilisé",

  app: "Application",
  averageRank: "Rang moyen",
  beyond100: "> 100",
  classLabel: "Type",
  count: "Nombre",
  lastSeen: "Dernière fois",
  detail: "Détail",
  noErrors: "Rien à signaler — aucune erreur enregistrée.",
  difficultyFewIncumbents: "peu de concurrents connus",
  difficultyUnscored: "pas encore évalué — nécessite une observation classée",
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
 * this product needs — 0 and 2+ take the plural, 1 does not — so a full
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
 * build does not know — a new server verdict should read oddly, never vanish.
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
    <label className="lang-picker">
      <span className="sr-only">{t.language}</span>
      <select onChange={(e) => setLang(e.target.value as Lang)} value={lang}>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
