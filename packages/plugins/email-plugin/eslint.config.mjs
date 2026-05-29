// Plugin-author ESLint config — extends the gui-chat-protocol preset
// to ban node:fs / node:path / console / direct fetch so any
// platform bypass shows up at lint time. Tests under test/ are
// allowed to use node:assert / node:test directly.

import tseslint from "typescript-eslint";
import pluginPreset from "gui-chat-protocol/eslint-preset";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  },
  ...pluginPreset.map((entry) => ({ ...entry, files: ["src/**/*.ts"] })),
];
