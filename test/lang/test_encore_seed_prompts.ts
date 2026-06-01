// Guards the Encore plugin-seeded chat prompt i18n (#1545).
//
// The dashboard "+ Add" (startSetupChat) and per-obligation chat
// (startObligationChat) buttons send only the user's `locale`; the
// server localizes the seed prompt from the shared `src/lang`
// dictionaries via `localizedSeedPrompt`. This test locks invariants
// vue-tsc alone doesn't cover:
//
//   - every locale carries both seed-prompt keys, and the obligation
//     template keeps the `{displayName}` / `{obligationId}` placeholders
//     verbatim (a dropped placeholder would surface a raw `{obligationId}`
//     to the user / LLM)
//   - localizedSeedPrompt selects the right locale, interpolates the
//     dynamic pieces, and falls back to English for an unsupported or
//     omitted locale
//
// No server side-effects: only the static dictionaries and the pure
// localizer are exercised — `startChat` is never invoked.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { messages, SUPPORTED_LOCALES } from "../../src/lang/index.js";
import { localizedSeedPrompt } from "../../server/encore/handlers/shared.js";

describe("encore seed prompt i18n lockstep (#1545)", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale}: seedPrompts.setup is a non-empty string`, () => {
      const { setup } = messages[locale].encoreDashboard.seedPrompts;
      assert.equal(typeof setup, "string");
      assert.ok(setup.trim().length > 0, "setup seed prompt must not be empty");
    });

    it(`${locale}: seedPrompts.obligation keeps both interpolation placeholders`, () => {
      const { obligation } = messages[locale].encoreDashboard.seedPrompts;
      assert.ok(obligation.includes("{displayName}"), "must keep {displayName} placeholder");
      assert.ok(obligation.includes("{obligationId}"), "must keep {obligationId} placeholder");
    });
  }
});

describe("localizedSeedPrompt (#1545)", () => {
  it("returns the requested locale's setup prompt verbatim", () => {
    assert.equal(localizedSeedPrompt("fr", "setup"), messages.fr.encoreDashboard.seedPrompts.setup);
  });

  it("interpolates the obligation displayName + obligationId", () => {
    const out = localizedSeedPrompt("ja", "obligation", { displayName: "歯医者", obligationId: "dentist-1" });
    assert.ok(out.includes("歯医者"), "displayName must be interpolated");
    assert.ok(out.includes("dentist-1"), "obligationId must be interpolated");
    assert.ok(!out.includes("{displayName}") && !out.includes("{obligationId}"), "no raw placeholders should remain");
  });

  it("falls back to English when the locale is omitted", () => {
    assert.equal(localizedSeedPrompt(undefined, "setup"), messages.en.encoreDashboard.seedPrompts.setup);
  });

  it("falls back to English for an unsupported locale", () => {
    assert.equal(localizedSeedPrompt("xx", "setup"), messages.en.encoreDashboard.seedPrompts.setup);
  });

  it("leaves an unprovided placeholder intact rather than blanking it", () => {
    const out = localizedSeedPrompt("en", "obligation", { obligationId: "x" });
    assert.ok(out.includes("{displayName}"), "unprovided placeholder stays literal");
  });
});
