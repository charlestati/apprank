import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, vitest],
  ignorePatterns: [
    ...core.ignorePatterns,
    "**/worker-configuration.d.ts",
    "**/migrations/**",
  ],
  rules: {
    // The collector is deliberately sequential: one paced Apple request at a
    // time is the politeness mechanism, not an oversight.
    "no-await-in-loop": "off",
    // House style: inline comments and declaration-style functions are used
    // throughout; key order follows meaning, not the alphabet.
    "func-style": "off",
    "no-inline-comments": "off",
    "sort-keys": "off",
    "react/function-component-definition": "off",
    // Small co-located error classes next to their client.
    "max-classes-per-file": "off",
    // The schema barrel is the package's public surface, on purpose.
    "oxc/no-barrel-file": "off",
  },
  // Note: the ultracite vitest preset applies its rules via its own override
  // block, which wins over top-level overrides here — test-specific
  // relaxations therefore live as justified file-header disables in the test
  // files themselves.
});
