import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
	...ultracite,
	proseWrap: "always",
	useTabs: true,
});
