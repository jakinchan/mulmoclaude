// Shared ESLint config for @mulmobridge/* packages.
// Each package extends this with its own eslint.config.mjs.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import sonarjs from "eslint-plugin-sonarjs";

const packagesConfig = [
  eslint.configs.recommended,
  sonarjs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "error",
      // Mirror the root config: many node:test cases drive an observed
      // side-effect (no throw / no log) and intentionally have no
      // inline assert. Demoted to warn so reviewers still see it
      // without blocking CI.
      "sonarjs/assertions-in-tests": "warn",
      // Mirror the root config: `x?: T | undefined` is not redundant under
      // `exactOptionalPropertyTypes` — with the flag on `x?: T` REJECTS an
      // explicit `undefined`, so the spelling this rule wants removed is the
      // one that says "absent and undefined mean the same thing here".
      "sonarjs/no-redundant-optional": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^__", varsIgnorePattern: "^__" }],
      // Workspace-package boundary restriction (C2 / #1141 family).
      // Each package should be self-contained and reachable from the
      // rest of the repo only through its declared package name
      // (and `package.json#exports`), never via deep relative paths
      // into another package's `src/` or into the host's `src/` /
      // `server/`.
      //
      // Depth-agnostic via `regex`: the threshold for "boundary-
      // crossing" is at least 2 `../` segments before `src/` or
      // `server/`. A test inside the package importing its own
      // `../src/types` (one `../`) stays allowed; anything deeper
      // (`../../*/src/...`, `../../../src/...`, `../../../../src/...`,
      // …) fires regardless of how nested the source file is. Earlier
      // depth-enumerated globs left a Codex-flagged bypass at depth 6.
      "no-restricted-imports": [
        "error",
        {
          // `allowTypeImports` deliberately omitted: a type-only
          // `import type { ... } from "../../sibling/src/..."` still
          // couples the package's PUBLISHED type surface to a
          // sibling's internal source, which means publishing the
          // package independently breaks (the consumer can't resolve
          // the type from the package alone). Codex iter-2 #1148
          // flagged the original `allowTypeImports: true` as a real
          // hole in the boundary policy.
          patterns: [
            {
              regex: "^(\\.\\./){2,}.*src(/|$)",
              message:
                "Workspace packages must not deep-import another package's `src/` (or the host's `src/`) — type-only imports included. Use the package name (and its `package.json#exports`) instead — the boundary exists so each package can publish independently.",
            },
            {
              regex: "^(\\.\\./){2,}.*server(/|$)",
              message:
                "Workspace packages must not import the host's `server/*` modules — type-only imports included. Packages run as their own processes / bundles; reaching into server code couples them to the host runtime.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
];

export default packagesConfig;
