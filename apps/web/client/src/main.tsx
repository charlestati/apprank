import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

import "./theme.css";

const root = document.querySelector("#root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>
	);
}
