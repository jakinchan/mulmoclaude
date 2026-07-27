// The shell-shadows-`.env` boot diagnostic (#2604).
//
// Only the pure half is covered here: what counts as a conflict, how the
// key list is normalised, and — the part that actually matters — that the
// notification id is stable for the same set of keys and different for a
// different set. That id is what stops a reboot with an unfixed conflict
// from stacking a second bell entry, and what makes fixing one of two keys
// replace the entry instead of leaving one naming the key already fixed.
//
// `announceShadowedEnv` itself is a thin wrapper (log + dedupe + publish)
// over `publishNotification`, whose behaviour is pinned in the notifier
// suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShadowedEnvKeys, shadowedEnvDiagnostic } from "../../server/system/shadowedEnv.js";

describe("parseShadowedEnvKeys", () => {
  it("reads the launcher's CSV", () => {
    assert.deepEqual(parseShadowedEnvKeys("GEMINI_API_KEY,OPENAI_API_KEY"), ["GEMINI_API_KEY", "OPENAI_API_KEY"]);
  });

  it("treats absent / empty / whitespace-only as nothing to report", () => {
    assert.deepEqual(parseShadowedEnvKeys(undefined), []);
    assert.deepEqual(parseShadowedEnvKeys(""), []);
    assert.deepEqual(parseShadowedEnvKeys("   "), []);
    assert.deepEqual(parseShadowedEnvKeys(",,,"), []);
  });

  it("trims padding and drops empty entries", () => {
    assert.deepEqual(parseShadowedEnvKeys(" A , ,B ,"), ["A", "B"]);
  });

  it("drops anything that isn't an env var name — a KEY=secret token must never be rendered", () => {
    // The launcher only sends `Object.keys(...)`, but this value arrives
    // through `process.env`, which anything on the box can set.
    assert.deepEqual(parseShadowedEnvKeys("GEMINI_API_KEY=would-leak"), []);
    assert.deepEqual(parseShadowedEnvKeys("OK_KEY,GEMINI_API_KEY=would-leak"), ["OK_KEY"]);
    assert.deepEqual(parseShadowedEnvKeys("has space,has-dash,9leading,{}"), []);
  });

  it("de-duplicates and sorts, so parse order can't change the identity", () => {
    assert.deepEqual(parseShadowedEnvKeys("B,A,B"), ["A", "B"]);
    assert.deepEqual(parseShadowedEnvKeys("A,B"), parseShadowedEnvKeys("B,A"));
  });
});

describe("shadowedEnvDiagnostic", () => {
  it("reports nothing when no key is shadowed", () => {
    assert.equal(shadowedEnvDiagnostic([]), null);
  });

  it("names the keys and points at the shell as the winner", () => {
    const diagnostic = shadowedEnvDiagnostic(["GEMINI_API_KEY"]);
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /GEMINI_API_KEY/);
    assert.match(diagnostic.message, /shell value wins/);
    assert.equal(diagnostic.i18n.titleKey, "shadowedEnv.title");
    assert.equal(diagnostic.i18n.bodyKey, "shadowedEnv.body");
    assert.deepEqual(diagnostic.i18n.bodyParams, { keys: "GEMINI_API_KEY" });
  });

  it("keeps the id stable for the same keys — a reboot must not stack a second entry", () => {
    const first = shadowedEnvDiagnostic(parseShadowedEnvKeys("A,B"));
    const second = shadowedEnvDiagnostic(parseShadowedEnvKeys("B,A"));
    assert.equal(first?.id, second?.id);
  });

  it("changes the id when the key set changes — a fixed key must not linger in the text", () => {
    const both = shadowedEnvDiagnostic(["A", "B"]);
    const onlyA = shadowedEnvDiagnostic(["A"]);
    assert.notEqual(both?.id, onlyA?.id);
  });

  it("caps the rendered names so a fully-shadowed .env stays readable", () => {
    const keys = Array.from({ length: 25 }, (_, i) => `KEY_${String(i).padStart(2, "0")}`);
    const diagnostic = shadowedEnvDiagnostic(keys);
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /\(\+5 more\)/);
    assert.ok(!diagnostic.message.includes("KEY_20"), "keys past the cap must not be rendered");
    // The id stays complete — it identifies the conflict, not the display.
    assert.ok(diagnostic.id.includes("KEY_24"));
  });

  it("never carries a value — a name=value handoff yields nothing at all", () => {
    const clean = shadowedEnvDiagnostic(parseShadowedEnvKeys("GEMINI_API_KEY"));
    assert.ok(clean);
    assert.ok(!clean.message.includes("="), "a name=value pair would leak the secret into the bell");
    // And the pair can't survive the parse in the first place, so there
    // is nothing left to render.
    assert.equal(shadowedEnvDiagnostic(parseShadowedEnvKeys("GEMINI_API_KEY=would-leak")), null);
  });
});
