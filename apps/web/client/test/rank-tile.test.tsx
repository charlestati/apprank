import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RankTile } from "../src/components/rank-tile";

describe(RankTile, () => {
	it("renders a dash for an unranked keyword", () => {
		render(<RankTile rank={null} />);
		const tile = screen.getByLabelText("not ranked");
		expect(tile.textContent).toBe("–");
		expect(tile.className).toBe("tile-btn tile-none");
		expect(tile.title).toBe("not ranked");
	});

	it("qualifies the unranked tooltip with the keyword when given", () => {
		render(<RankTile rank={null} title="example keyword · FR" />);
		expect(screen.getByLabelText("not ranked").title).toBe(
			"example keyword · FR: not ranked (top 200)"
		);
	});

	it.each([
		{ band: "tile-top", rank: 1 },
		{ band: "tile-top", rank: 10 },
		{ band: "tile-mid", rank: 11 },
		{ band: "tile-mid", rank: 50 },
		{ band: "tile-low", rank: 51 },
		{ band: "tile-low", rank: 200 },
	])("puts rank $rank in $band", ({ band, rank }) => {
		render(<RankTile rank={rank} />);
		const tile = screen.getByRole("button", { name: String(rank) });
		expect(tile.className).toBe(`tile-btn ${band}`);
		expect(tile.title).toBe(`#${rank}`);
	});

	it("prefixes the tooltip with the keyword and fires onClick", () => {
		const onClick = vi.fn<() => void>();
		render(
			<RankTile onClick={onClick} rank={3} title="example keyword · FR" />
		);
		const tile = screen.getByRole("button", { name: "3" });
		expect(tile.title).toBe("example keyword · FR: #3");
		fireEvent.click(tile);
		expect(onClick).toHaveBeenCalledOnce();
	});
});
