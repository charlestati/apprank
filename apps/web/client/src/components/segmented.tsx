// The time-range control: one choice out of a short, fixed set, all of them
// worth seeing at once.
//
// It was a `<fieldset>`, which carries the user agent's own margin and
// padding. That is what put it a few pixels below the select beside it no
// matter what the filter bar aligned on.

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";

interface Props<T extends string> {
	value: T;
	onValueChange: (value: T) => void;
	options: { value: T; label: string }[];
	label: string;
}

export function Segmented<T extends string>({
	value,
	onValueChange,
	options,
	label,
}: Props<T>) {
	return (
		<ToggleGroup
			aria-label={label}
			className="segmented"
			onValueChange={(next) => {
				// Pressing the active segment would otherwise empty the group, and a
				// report with no window is not a state this page has.
				const chosen = next[0] as T | undefined;
				if (chosen !== undefined) {
					onValueChange(chosen);
				}
			}}
			value={[value]}
		>
			{options.map((option) => (
				<Toggle className="seg" key={option.value} value={option.value}>
					{option.label}
				</Toggle>
			))}
		</ToggleGroup>
	);
}
