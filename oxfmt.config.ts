import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
	...ultracite,
	// Ultracite ships proseWrap "never", which forces every markdown paragraph
	// onto one line. Wrap to printWidth instead: a one-word edit then shows as a
	// one-line diff in review rather than a whole repainted paragraph.
	proseWrap: "always",
	// Tabs, matching .editorconfig. Indent width is then the reader's setting
	// rather than the author's.
	useTabs: true,
});
