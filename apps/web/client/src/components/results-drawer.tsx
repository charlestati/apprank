// The full result page behind one observation. We keep 200 track ids per
// crawl, so this is the deep view: rank 47 today is what tells you when a
// climb started. Apps we have never met show as ids: honest, not dropped.

import { Drawer } from "@base-ui/react/drawer";
import { useEffect, useState } from "react";

import { api } from "../api";
import type { KeywordRow, ResultPage } from "../api";
import { useFormat } from "../format";
import { fmt, useT } from "../i18n";
import { AppIcon } from "./app-icon";

interface Props {
	row: KeywordRow;
	storefront: string;
	trackedAppId: number | null;
	onClose: () => void;
}

export function ResultsDrawer({
	row,
	storefront,
	trackedAppId,
	onClose,
}: Props) {
	const f = useFormat();
	const t = useT();
	const [page, setPage] = useState<ResultPage | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		(async () => {
			try {
				setPage(await api.results(row.pairId));
			} catch {
				setFailed(true);
			}
		})();
	}, [row.pairId]);

	// Escape, the outside press, the focus trap and the scroll lock all come
	// from the component now. The hand-rolled version had only the first, and
	// left focus behind in the table it covered.
	return (
		<Drawer.Root
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open
		>
			<Drawer.Portal>
				<Drawer.Backdrop className="ui-backdrop" />
				<Drawer.Popup
					aria-label={fmt(t.drawerSearchResults, { keyword: row.keyword })}
					className="drawer"
				>
					<header className="drawer-head">
						<div>
							<Drawer.Title className="drawer-title">
								“{row.keyword}”
							</Drawer.Title>
							<p className="drawer-sub">
								{f.region(storefront)} ·{" "}
								{page?.date
									? fmt(t.drawerObserved, { date: f.day(page.date) })
									: t.loading}
								{page
									? ` · ${fmt(t.drawerResultCount, { n: f.number(page.resultCount) })}`
									: ""}
							</p>
						</div>
						<Drawer.Close className="link">{t.close}</Drawer.Close>
					</header>

					{failed ? <p className="empty">{t.drawerFailed}</p> : null}

					<ol className="result-list">
						{(page?.results ?? []).map((r) => (
							<li
								className={
									r.appId === trackedAppId
										? "result-row row-self"
										: "result-row"
								}
								key={r.appId}
							>
								<span className="result-position">{r.position}</span>
								<AppIcon
									className="result-icon"
									iconUrl={r.iconUrl}
									name={r.name}
								/>
								<span className="result-name">
									{r.name ?? fmt(t.appFallback, { id: r.appId })}
									{r.developer ? (
										<span className="result-developer">{r.developer}</span>
									) : null}
								</span>
							</li>
						))}
					</ol>
				</Drawer.Popup>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
