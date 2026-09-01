// The signature element: a word-game letter tile carrying a rank.
// Band by threshold that matters (top-10 strong, top-50 mid, rest quiet).

interface Props {
  rank: number | null;
  onClick?: () => void;
  title?: string;
}

export function RankTile({ rank, onClick, title }: Props) {
  if (rank === null) {
    return (
      <span
        className="tile-btn tile-none"
        title={title ? `${title} — not ranked (top 200)` : "not ranked"}
        aria-label="not ranked"
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
