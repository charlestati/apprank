// The one place the report explains itself.
//
// Every number on this page is a derived quantity somebody has to trust: a
// difficulty we compute ourselves, a popularity Apple publishes for some terms
// and not others, a rank that moved against a previous observation rather than
// against yesterday. A column header cannot carry that, and a `title`
// attribute is invisible to touch and to the keyboard, so the explanation
// hangs off a real focusable trigger instead.
//
// A popover, not a tooltip. Base UI's tooltip opens on mouse hover and on
// keyboard focus only: a tap is neither, so on a phone every "?" was a button
// that did nothing. A popover's trigger toggles on click, which a tap and
// Enter both produce, and `openOnHover` keeps the pointer behaviour.

import { Popover } from "@base-ui/react/popover";
import type { ReactNode } from "react";

import { fmt, useT } from "../i18n";

interface HintProps {
	/** The trigger's accessible name. */
	label: string;
	/** `infotip` is the round "?"; a mark such as an asterisk passes its own. */
	className: string;
	/** What the trigger draws. Decorative: the label is what is announced. */
	mark: ReactNode;
	children: string;
}

/** A mark with a sentence behind it, opened by hover, tap or the keyboard. */
export function Hint({ label, className, mark, children }: HintProps) {
	return (
		<Popover.Root>
			<Popover.Trigger
				aria-label={label}
				className={className}
				delay={150}
				openOnHover
				type="button"
			>
				<span aria-hidden="true">{mark}</span>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner className="ui-layer" sideOffset={6}>
					<Popover.Popup className="tip-popup">{children}</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

interface Props {
	/** What is being explained, e.g. "Difficulty". Names the trigger. */
	label: string;
	children: string;
}

export function InfoTip({ label, children }: Props) {
	const t = useT();
	return (
		<Hint className="infotip" label={fmt(t.explainAbout, { label })} mark="?">
			{children}
		</Hint>
	);
}
