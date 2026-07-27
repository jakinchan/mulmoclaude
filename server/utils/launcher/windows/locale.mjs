// Windows tells a script its UI language as a numeric LCID, not a tag.
//
// `GetLocale()` in the .vbs stub returns e.g. 1041, never "ja-JP", so
// the launcher needs a number → language step that macOS did not. PR1's
// last surviving bug was exactly this kind of second, divergent locale
// resolution (a shell `cut` disagreeing with `pickLauncherLocale`), so
// the mapping lives here as a pure function and the stub is given no
// table at all: the generated message files are NAMED by the primary
// language id, leaving the .vbs with nothing to decide.

import { LAUNCHER_LOCALES, pickLauncherLocale } from "../messages.mjs";

// An LCID packs the sublanguage in its high bits: 1041 and 2129 are
// both Japanese, 1046 (pt-BR) and 2070 (pt-PT) are both Portuguese.
// Only the low 10 bits — the primary language — decide the catalogue,
// which is also why `pt-PT` lands on the shipped `pt-BR` text rather
// than on English.
const PRIMARY_LANGUAGE_MASK = 0x3ff;

// Primary language id → the BCP-47 tag that language would report
// elsewhere. Kept as tags rather than as launcher locales so the
// answer still comes from `pickLauncherLocale`: one rule, one place.
const PRIMARY_LANGUAGE_TAGS = {
  0x04: "zh",
  0x07: "de",
  0x09: "en",
  0x0a: "es",
  0x0c: "fr",
  0x11: "ja",
  0x12: "ko",
  0x16: "pt",
};

/**
 * @param {number} lcid
 * @returns {number}
 */
export function primaryLanguageId(lcid) {
  return lcid & PRIMARY_LANGUAGE_MASK;
}

/**
 * The launcher locale a Windows machine reporting `lcid` should read.
 * @param {number} lcid
 * @returns {string}
 */
export function launcherLocaleForLcid(lcid) {
  if (!Number.isInteger(lcid) || lcid < 0) return pickLauncherLocale("");
  return pickLauncherLocale(PRIMARY_LANGUAGE_TAGS[primaryLanguageId(lcid)] ?? "");
}

/**
 * Every primary language id worth writing a message file for, paired
 * with the locale whose text it should hold. Ids that resolve to the
 * default are omitted — the stub already falls back to `en.txt`.
 * @returns {{ primaryLanguageId: number, locale: string }[]}
 */
export function windowsMessageFileTargets() {
  return Object.keys(PRIMARY_LANGUAGE_TAGS)
    .map(Number)
    .map((languageId) => ({ primaryLanguageId: languageId, locale: launcherLocaleForLcid(languageId) }))
    .filter(({ locale }) => LAUNCHER_LOCALES.includes(locale));
}
