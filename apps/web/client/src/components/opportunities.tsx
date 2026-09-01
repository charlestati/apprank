// The answer to "what should I do at the next release?", above the table that
// justifies it.
//
// Two ideas drive this panel. First, an average rank across a portfolio of
// keywords is a vanity number — what matters is how many terms sit in the zone
// that earns taps at all. Second, brand searches are demand you already own, so
// counting them alongside generic wins flatters the picture; ASO progress is
// the generic column.

import type { KeywordRow, Report } from "../api";
import { fmt, plural, useT } from "../i18n";
import type { Dictionary } from "../i18n";

const lanesFor = (t: Dictionary) =>
  [
    {
      hint: t.laneWinningHint,
      key: "winning",
      label: t.laneWinning,
      tone: "lane-good",
    },
    {
      hint: t.laneCloseHint,
      key: "close",
      label: t.laneClose,
      tone: "lane-focus",
    },
    {
      hint: t.laneBlockedHint,
      key: "blocked",
      label: t.laneBlocked,
      tone: "lane-warn",
    },
    {
      hint: t.laneVanityHint,
      key: "vanity",
      label: t.laneVanity,
      tone: "lane-muted",
    },
    {
      hint: t.laneUnknownHint,
      key: "unknown",
      label: t.laneUnknown,
      tone: "lane-muted",
    },
  ] as const;

function pickExamples(rows: KeywordRow[], key: string): KeywordRow[] {
  return rows.filter((r) => r.verdict?.opportunity === key).slice(0, 3);
}

export function Opportunities({
  report,
  onSelect,
}: {
  report: Report;
  onSelect: (row: KeywordRow) => void;
}) {
  const t = useT();
  const lanes = lanesFor(t);
  const { insights, rows } = report;
  const counts: Record<string, number> = {
    blocked: insights.blocked,
    close: insights.close,
    unknown: insights.unknown,
    vanity: insights.vanity,
    winning: insights.winning,
  };
  // Apple lists only the top ~500 terms per country and genre, so a niche app
  // has no volume for most of its keywords. Saying so is the difference between
  // a thin read and a misleading one.
  const coverage =
    insights.unmeasuredKeywords > 0 ? (
      <p className="insights-sub">
        {fmt(t.coverageNote, {
          n: insights.unmeasuredKeywords,
          total: insights.brandKeywords + insights.genericKeywords,
        })}
      </p>
    ) : null;

  return (
    <section className="card insights">
      <header className="insights-head">
        <h2 className="section-title">{t.whatToWorkOn}</h2>
        <p className="insights-sub">
          {fmt(t.genericProgress, {
            inZone: insights.genericInTapZone,
            total: insights.genericKeywords,
          })}{" "}
          {insights.brandKeywords > 0
            ? plural(
                t,
                insights.brandKeywords,
                "brandCountedOne",
                "brandCounted"
              )
            : null}
        </p>
        {coverage}
      </header>

      <div className="lanes">
        {lanes.map((lane) => (
          <div className={`lane ${lane.tone}`} key={lane.key}>
            <div className="lane-count">{counts[lane.key] ?? 0}</div>
            <div className="lane-label">{lane.label}</div>
            <p className="lane-hint">{lane.hint}</p>
            <ul className="lane-examples">
              {pickExamples(rows, lane.key).map((row) => (
                <li key={row.pairId}>
                  <button
                    className="link"
                    onClick={() => onSelect(row)}
                    type="button"
                  >
                    {row.keyword}
                  </button>
                  <span className="lane-rank">
                    {row.position === null ? "—" : `#${row.position}`}
                    {row.popularity === null
                      ? ""
                      : fmt(t.opportunityPop, { n: row.popularity })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
