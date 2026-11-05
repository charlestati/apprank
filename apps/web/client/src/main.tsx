import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

import "@fontsource-variable/inter";

import "./theme.css";
import "./theme-appfigures.css";

const root = document.querySelector("#root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>
	);
}
