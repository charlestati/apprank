// App icon with a letter fallback. Apple's artwork URLs go stale, and we may
// never have captured one for an app seen deep in a result page, so a missing
// or broken icon has to degrade to something readable rather than a broken
// image glyph.

import { useState } from "react";

interface Props {
  name: string | null;
  iconUrl: string | null;
  className?: string;
}

export function AppIcon({ name, iconUrl, className }: Props) {
  const [broken, setBroken] = useState(false);
  const classes = className ? `app-icon ${className}` : "app-icon";

  if (!iconUrl || broken) {
    return (
      <span className={`${classes} icon-fallback`}>
        {(name ?? "?").slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      alt=""
      className={classes}
      onError={() => setBroken(true)}
      src={iconUrl}
    />
  );
}
