// Every select on the page, so a storefront, a language and a popularity band
// are the same control at three sizes rather than three native dropdowns the
// browser draws differently on every platform.
//
// The native `<select>` cannot be styled below its border: the option list is
// the OS's, which is why the dark surface stopped at the popup edge and why
// the control's height never matched the buttons beside it.

import { Select as BaseSelect } from "@base-ui/react/select";

export interface SelectOption<T extends string | number> {
	value: T;
	label: string;
}

interface Props<T extends string | number> {
	value: T;
	onValueChange: (value: T) => void;
	options: SelectOption<T>[];
	/** Names the control. Hidden visually when the surface already names it. */
	label: string;
	hiddenLabel?: boolean;
	/** `quiet` is the top bar: a control that should not compete with the data. */
	tone?: "default" | "quiet";
}

// Two marks, drawn rather than pulled from an icon set: the dependency would
// outweigh eight path commands, and these are the only glyphs the UI needs.
function Chevron() {
	return (
		<svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
			<path
				d="M2.5 4.5 6 8l3.5-3.5"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
		</svg>
	);
}

function Check() {
	return (
		<svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
			<path
				d="M2.5 6.5 5 9l4.5-6"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.75"
			/>
		</svg>
	);
}

export function Select<T extends string | number>({
	value,
	onValueChange,
	options,
	label,
	hiddenLabel = false,
	tone = "default",
}: Props<T>) {
	return (
		<BaseSelect.Root
			items={options}
			onValueChange={(next) => onValueChange(next as T)}
			value={value}
		>
			<BaseSelect.Label className={hiddenLabel ? "sr-only" : "field-label"}>
				{label}
			</BaseSelect.Label>
			<BaseSelect.Trigger
				className={
					tone === "quiet" ? "ui-trigger ui-trigger-quiet" : "ui-trigger"
				}
			>
				<BaseSelect.Value />
				<BaseSelect.Icon className="ui-trigger-icon">
					<Chevron />
				</BaseSelect.Icon>
			</BaseSelect.Trigger>
			<BaseSelect.Portal>
				<BaseSelect.Positioner alignItemWithTrigger={false} sideOffset={4}>
					<BaseSelect.Popup className="ui-popup">
						<BaseSelect.List>
							{options.map((option) => (
								<BaseSelect.Item
									className="ui-option"
									key={option.value}
									value={option.value}
								>
									<BaseSelect.ItemIndicator className="ui-option-check">
										<Check />
									</BaseSelect.ItemIndicator>
									<BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
								</BaseSelect.Item>
							))}
						</BaseSelect.List>
					</BaseSelect.Popup>
				</BaseSelect.Positioner>
			</BaseSelect.Portal>
		</BaseSelect.Root>
	);
}
