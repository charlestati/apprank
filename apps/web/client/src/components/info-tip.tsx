// The one place the report explains itself.
//
// Every number on this page is a derived quantity somebody has to trust: a
// difficulty we compute ourselves, a popularity Apple publishes for some terms
// and not others, a rank that moved against a previous observation rather than
// against yesterday. A column header cannot carry that, and a `title`
// attribute is invisible to touch and to the keyboard, so the explanation
// hangs off a real focusable trigger instead.

import { Tooltip } from "@base-ui/react/tooltip";

import { fmt, useT } from "../i18n";

interface Props {
	/** What is being explained, e.g. "Difficulty". Names the trigger. */
	label: string;
	children: string;
}

export function InfoTip({ label, children }: Props) {
	const t = useT();
	return (
		<Tooltip.Root>
			<Tooltip.Trigger
				aria-label={fmt(t.explainAbout, { label })}
				className="infotip"
				type="button"
			>
				<span aria-hidden="true">?</span>
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Positioner className="ui-layer" sideOffset={6}>
					<Tooltip.Popup className="tip-popup">{children}</Tooltip.Popup>
				</Tooltip.Positioner>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}
