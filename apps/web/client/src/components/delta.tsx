// Rank movement: positive change means the app moved towards rank 1.
// Direction is carried by an arrow glyph and a label, never by colour alone.

interface Props {
  change: number | null;
  daysAgo: number | null;
}

export function Delta({ change, daysAgo }: Props) {
  if (!change) {
    return (
      <span className="delta delta-flat" title="no change in this window">
        —
      </span>
    );
  }
  const improved = change > 0;
  return (
    <span className={improved ? "delta delta-up" : "delta delta-down"}>
      {daysAgo ? <span className="delta-age">{daysAgo}d</span> : null}
      <span aria-hidden="true">{improved ? "↑" : "↓"}</span>
      <span className="sr-only">{improved ? "up " : "down "}</span>
      {Math.abs(change)}
    </span>
  );
}
