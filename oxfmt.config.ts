import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Markdown is formatted by hand. oxfmt unwraps every paragraph onto one
  // line, which fights the editor and turns a one-word edit into a
  // whole-paragraph diff; prose wrapping is a judgement call, not a lint.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "**/*.md"],
});
