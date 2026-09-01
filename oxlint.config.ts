import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
	extends: [core, react, vitest],
	ignorePatterns: [
		...(core.ignorePatterns ?? []),
		"**/worker-configuration.d.ts",
		"**/migrations/**",
	],
	rules: {
		"no-await-in-loop": "off",
		"func-style": "off",
		"no-inline-comments": "off",
		"sort-keys": "off",
		"react/function-component-definition": "off",
		"max-classes-per-file": "off",
		"oxc/no-barrel-file": "off",
	},
});
