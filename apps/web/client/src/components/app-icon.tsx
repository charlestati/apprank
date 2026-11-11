// App icon with a letter fallback. Apple's artwork URLs go stale, and we may
// never have captured one for an app seen deep in a result page, so a missing
// or broken icon has to degrade to something readable rather than a broken
// image glyph.

import { useState } from "react";

interface Props {
	name: string | null;
	iconUrl: string | null;
	className?: string;
	/** The icon's accessible name, for a placement where nothing beside it says
	    which app it is. Left out where the name is already printed next to it,
	    so a screen reader does not read it twice. */
	label?: string;
}

export function AppIcon({ name, iconUrl, className, label }: Props) {
	const [broken, setBroken] = useState(false);
	const classes = className ? `app-icon ${className}` : "app-icon";

	if (!iconUrl || broken) {
		return (
			<span
				aria-label={label}
				className={`${classes} icon-fallback`}
				role={label ? "img" : undefined}
			>
				{(name ?? "?").slice(0, 1)}
			</span>
		);
	}
	return (
		<img
			alt={label ?? ""}
			className={classes}
			onError={() => setBroken(true)}
			src={iconUrl}
		/>
	);
}
