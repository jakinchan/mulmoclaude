// Generates MulmoClaude.app — a plain directory with an Info.plist and
// a shell script, which is all a macOS app bundle has to be.
//
// No Electron, no signing, no notarisation: a bundle we write ourselves
// never gets the `com.apple.quarantine` attribute, so Gatekeeper does
// not prompt. What it costs instead is that the bundle carries its own
// copy of the launcher modules — re-run `mulmoclaude create-shortcut`
// after upgrading to refresh them.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LAUNCHER_LOCALES, launcherMessages } from "../messages.mjs";
import { buildIcns } from "./icon.mjs";

const LAUNCHER_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const UTILS_SRC_DIR = join(LAUNCHER_SRC_DIR, "..");

export const BUNDLE_IDENTIFIER = "com.receptron.mulmoclaude.launcher";
const EXECUTABLE_NAME = "launch";
const ICON_BASENAME = "icon";
const EXECUTABLE_MODE = 0o755;

// Only what the bundle needs at runtime. Listing them beats copying the
// directory: the generator itself lives next to these files and must
// NOT ride along (it imports sharp, which the bundle has no access to).
const BUNDLED_FILES = [
  "launcher/run.mjs",
  "launcher/start.mjs",
  "launcher/detect-server.mjs",
  "launcher/launcher-page.mjs",
  "launcher/messages.mjs",
  "launcher/preflight.mjs",
  "launcher/macos/resolve-path.sh",
  "launcher/macos/message-file.sh",
  "port.mjs",
];

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * @param {{ name: string, version: string, identifier?: string }} options
 * @returns {string}
 */
export function renderInfoPlist({ name, version, identifier = BUNDLE_IDENTIFIER }) {
  const entries = [
    ["CFBundleName", name],
    ["CFBundleDisplayName", name],
    ["CFBundleExecutable", EXECUTABLE_NAME],
    ["CFBundleIconFile", ICON_BASENAME],
    ["CFBundleIdentifier", identifier],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    ["LSMinimumSystemVersion", "12.0"],
  ];
  const body = entries.map(([key, value]) => `  <key>${key}</key>\n  <string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * The "Node.js is missing" text, flattened for the shell stub: first
 * line is the alert title, the rest is its message. A file rather than
 * a generated shell string so translated prose never has to survive
 * quoting into both sh and AppleScript.
 * @param {string} locale
 * @returns {string}
 */
export function renderNodeMissingText(locale) {
  const { nodeMissing } = launcherMessages(locale);
  // Line 1 is the title and line 2 starts the body — the stub splits on
  // exactly that, so a blank second line would open the alert with an
  // empty paragraph.
  return [nodeMissing.title, nodeMissing.body, "", nodeMissing.action, "", nodeMissing.hint].join("\n");
}

/**
 * Write the alert text the shell stub reads, one file per locale.
 * @param {string} resourcesDir
 * @returns {void}
 */
export function writeBundleMessages(resourcesDir) {
  const dir = join(resourcesDir, "messages");
  mkdirSync(dir, { recursive: true });
  LAUNCHER_LOCALES.forEach((locale) => {
    writeFileSync(join(dir, `${locale}.txt`), renderNodeMissingText(locale));
    // The stub's second step is the language subtag, so a `pt` or `pt-PT`
    // system needs a `pt` alias to get Portuguese instead of English —
    // matching what `pickLauncherLocale` answers for those tags.
    const [language] = locale.split("-");
    if (language !== locale) writeFileSync(join(dir, `${language}.txt`), renderNodeMissingText(locale));
  });
}

function copyBundledFiles(resourcesDir) {
  const utilsDir = join(resourcesDir, "utils");
  BUNDLED_FILES.forEach((relative) => {
    const target = join(utilsDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(UTILS_SRC_DIR, relative), target);
  });
}

function writeExecutable(macosDir) {
  mkdirSync(macosDir, { recursive: true });
  const target = join(macosDir, EXECUTABLE_NAME);
  writeFileSync(target, readFileSync(join(LAUNCHER_SRC_DIR, "macos", "launch.sh"), "utf8"));
  chmodSync(target, EXECUTABLE_MODE);
}

/**
 * Write (or overwrite) an app bundle at `bundlePath`.
 * @param {{ bundlePath: string, name: string, version: string }} options
 * @returns {Promise<{ bundlePath: string, iconWritten: boolean }>}
 */
export async function createAppBundle({ bundlePath, name, version }) {
  rmSync(bundlePath, { recursive: true, force: true });
  const contentsDir = join(bundlePath, "Contents");
  const resourcesDir = join(contentsDir, "Resources");
  mkdirSync(resourcesDir, { recursive: true });

  writeFileSync(join(contentsDir, "Info.plist"), renderInfoPlist({ name, version }));
  writeExecutable(join(contentsDir, "MacOS"));
  copyBundledFiles(resourcesDir);
  writeBundleMessages(resourcesDir);
  const iconWritten = await buildIcns(join(resourcesDir, `${ICON_BASENAME}.icns`));

  return { bundlePath, iconWritten };
}
