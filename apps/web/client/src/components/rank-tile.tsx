// The signature element: a word-game letter tile carrying a rank.
// Band by threshold that matters (top-10 strong, top-50 mid, rest quiet).

import { fmt, useT } from "../i18n";

interface Props {
  rank: number | null;
  onClick?: () => void;
  title?: string;
}

export function RankTile({ rank, onClick, title }: Props) {
  const t = useT();
  if (rank === null) {
    return (
      <span
        className="tile-btn tile-none"
        title={title ? fmt(t.notRankedTitled, { title }) : t.notRanked}
        aria-label={t.notRanked}
      >
        –
      </span>
    );
  }
  let band = "tile-low";
  if (rank <= 10) {
    band = "tile-top";
  } else if (rank <= 50) {
    band = "tile-mid";
  }
  return (
    <button
      className={`tile-btn ${band}`}
      onClick={onClick}
      title={title ? `${title} — #${rank}` : `#${rank}`}
      type="button"
    >
      {rank}
    </button>
  );
}
