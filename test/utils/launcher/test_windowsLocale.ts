// Tests for `server/utils/launcher/windows/locale.mjs`.
//
// Windows reports its UI language as a number, so the launcher gains a
// second locale resolution step that macOS never had. PR1's last bug
// was precisely a second resolution disagreeing with the first, so the
// property under test is agreement: an LCID must land wherever
// `pickLauncherLocale` would put the same language.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LAUNCHER_LOCALES, pickLauncherLocale } from "../../../server/utils/launcher/messages.mjs";
import { launcherLocaleForLcid, primaryLanguageId, windowsMessageFileTargets } from "../../../server/utils/launcher/windows/locale.mjs";

// Real LCIDs, as `GetLocale()` reports them. The pairs matter more than
// the numbers: both members of each pair must resolve identically,
// because they differ only in sublanguage.
const LCIDS = {
  enUS: 1033,
  enGB: 2057,
  jaJP: 1041,
  zhCN: 2052,
  zhTW: 1028,
  koKR: 1042,
  esES: 3082,
  esMX: 2058,
  ptBR: 1046,
  ptPT: 2070,
  frFR: 1036,
  deDE: 1031,
};

describe("launcherLocaleForLcid", () => {
  it("resolves the languages the launcher ships", () => {
    assert.equal(launcherLocaleForLcid(LCIDS.enUS), "en");
    assert.equal(launcherLocaleForLcid(LCIDS.jaJP), "ja");
    assert.equal(launcherLocaleForLcid(LCIDS.zhCN), "zh");
    assert.equal(launcherLocaleForLcid(LCIDS.koKR), "ko");
    assert.equal(launcherLocaleForLcid(LCIDS.esES), "es");
    assert.equal(launcherLocaleForLcid(LCIDS.ptBR), "pt-BR");
    assert.equal(launcherLocaleForLcid(LCIDS.frFR), "fr");
    assert.equal(launcherLocaleForLcid(LCIDS.deDE), "de");
  });

  it("ignores the sublanguage — only the primary language picks the catalogue", () => {
    assert.equal(launcherLocaleForLcid(LCIDS.enGB), launcherLocaleForLcid(LCIDS.enUS));
    assert.equal(launcherLocaleForLcid(LCIDS.zhTW), launcherLocaleForLcid(LCIDS.zhCN));
    assert.equal(launcherLocaleForLcid(LCIDS.esMX), launcherLocaleForLcid(LCIDS.esES));
    // Portuguese ships only as pt-BR, so a pt-PT machine gets Portuguese
    // rather than English — the same answer pickLauncherLocale gives.
    assert.equal(launcherLocaleForLcid(LCIDS.ptPT), "pt-BR");
  });

  it("agrees with pickLauncherLocale for every language it knows", () => {
    const tags: Record<number, string> = {
      [LCIDS.enUS]: "en-US",
      [LCIDS.jaJP]: "ja-JP",
      [LCIDS.zhCN]: "zh-CN",
      [LCIDS.koKR]: "ko-KR",
      [LCIDS.esES]: "es-ES",
      [LCIDS.ptBR]: "pt-BR",
      [LCIDS.frFR]: "fr-FR",
      [LCIDS.deDE]: "de-DE",
    };
    Object.entries(tags).forEach(([lcid, tag]) => {
      assert.equal(launcherLocaleForLcid(Number(lcid)), pickLauncherLocale(tag), tag);
    });
  });

  it("falls back to English instead of throwing on nonsense", () => {
    // 0x1D is Swedish — a real language the launcher does not ship.
    assert.equal(launcherLocaleForLcid(0x041d), "en");
    assert.equal(launcherLocaleForLcid(0), "en");
    assert.equal(launcherLocaleForLcid(-1), "en");
    assert.equal(launcherLocaleForLcid(Number.NaN), "en");
  });
});

describe("primaryLanguageId", () => {
  it("keeps the low 10 bits", () => {
    assert.equal(primaryLanguageId(LCIDS.jaJP), 0x11);
    assert.equal(primaryLanguageId(LCIDS.enGB), primaryLanguageId(LCIDS.enUS));
  });
});

describe("windowsMessageFileTargets", () => {
  it("names a file per shipped language, so the stub needs no table of its own", () => {
    const targets = windowsMessageFileTargets();
    assert.equal(targets.length, LAUNCHER_LOCALES.length);
    targets.forEach(({ primaryLanguageId: languageId, locale }) => {
      assert.ok(LAUNCHER_LOCALES.includes(locale), locale);
      assert.equal(launcherLocaleForLcid(languageId), locale);
    });
    // Every shipped locale must be reachable from some LCID, or a
    // translation would exist that no machine could ever display.
    const covered = new Set(targets.map(({ locale }) => locale));
    LAUNCHER_LOCALES.forEach((locale) => assert.ok(covered.has(locale), `${locale} is unreachable from any LCID`));
  });
});
