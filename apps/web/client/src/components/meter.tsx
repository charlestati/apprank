/* oxlint-disable jsx-a11y/prefer-tag-over-role -- role="img" gives the bar a
   single accessible name; an <img> tag cannot render a CSS-drawn meter. */

// Inline magnitude bar with its value beside it — the table's densest signal.
// The number is always present, so the bar is decoration, not the only channel.

interface Props {
  value: number | null;
  max?: number;
  label: string;
}

export function Meter({ value, max = 100, label }: Props) {
  const pct =
    value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="meter">
      <span
        aria-label={value === null ? `${label}: no data` : `${label}: ${value}`}
        className="meter-track"
        role="img"
      >
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-value">{value ?? "—"}</span>
    </span>
  );
}
