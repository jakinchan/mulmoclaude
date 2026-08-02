// Dump src/lang/*.ts to .i18n-cache/*.json so
// @intlify/eslint-plugin-vue-i18n can load them via
// `settings['vue-i18n'].localeDir`. The plugin only reads JSON/YAML,
// not TypeScript — this bridges the gap without forcing the app to
// maintain dictionaries in JSON (which loses the `typeof en` module
// augmentation we rely on for compile-time key checks).
//
// Run via `yarn dumpi18n`. `yarn lint` runs it first so the cache is
// always fresh before eslint consumes it.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import enMessages from "../src/lang/en";
import jaMessages from "../src/lang/ja";

const locales = { en: enMessages, ja: jaMessages };

// vue-i18n supports a "message function" form — e.g.
// `argsPlaceholder: () => "…"`. JSON.stringify skips those keys
// (functions → undefined). Substituting a placeholder literal in the
// replacer keeps the key visible to the eslint plugin; the runtime
// dictionary keeps the function, only the lint cache loses it.
const MESSAGE_FUNCTION_PLACEHOLDER = "[message-function]";

const replaceMessageFunctions = (_key: string, value: unknown): unknown => (typeof value === "function" ? MESSAGE_FUNCTION_PLACEHOLDER : value);

const thisFile = url.fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");
const outDir = path.join(repoRoot, ".i18n-cache");

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await Promise.all(
    Object.entries(locales).map(([locale, dict]) =>
      writeFile(path.join(outDir, `${locale}.json`), `${JSON.stringify(dict, replaceMessageFunctions, 2)}\n`, "utf8"),
    ),
  );
  console.log(`i18n JSON dumped to ${path.relative(repoRoot, outDir)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
