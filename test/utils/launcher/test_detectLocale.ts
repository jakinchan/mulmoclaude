// Tests for `detectLocale` in `server/utils/launcher/start.mjs`.
//
// This decides the language of every screen the launcher renders itself
// — progress page, error page, preflight guidance. It is a SECOND
// locale resolution beside the one the native no-node dialog uses, and
// the failure mode is silent: pages in English on a machine whose OS is
// not, with nothing logged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectLocale } from "../../../server/utils/launcher/start.mjs";

const never = () => {
  throw new Error("must not be called");
};

describe("detectLocale on Windows", () => {
  it("reads the OS language through Intl — there is no `defaults` and no LANG", () => {
    // Left unfixed, a Japanese Windows machine showed English pages while
    // the .vbs dialog spoke Japanese: the two halves disagreeing again.
    assert.equal(detectLocale({ platform: "win32", env: {}, run: never, intl: () => "ja-JP" }), "ja");
    assert.equal(detectLocale({ platform: "win32", env: {}, run: never, intl: () => "pt-PT" }), "pt-BR");
  });

  it("never shells out to the macOS-only source", () => {
    // `run` throws, so reaching it fails the test rather than silently
    // costing a failed subprocess on every launch.
    assert.equal(detectLocale({ platform: "win32", env: {}, run: never, intl: () => "de-DE" }), "de");
  });

  it("prefers an explicit LANG when a terminal supplies one", () => {
    assert.equal(detectLocale({ platform: "win32", env: { LANG: "fr_FR.UTF-8" }, run: never, intl: () => "en-US" }), "fr");
  });

  it("falls back to English when the OS reports a language we do not ship", () => {
    assert.equal(detectLocale({ platform: "win32", env: {}, run: never, intl: () => "sw-KE" }), "en");
    assert.equal(detectLocale({ platform: "win32", env: {}, run: never, intl: () => "" }), "en");
  });
});

describe("detectLocale on macOS", () => {
  it("still asks AppleLocale first — a GUI launch inherits no LANG", () => {
    assert.equal(detectLocale({ platform: "darwin", env: { LANG: "en_US.UTF-8" }, run: () => "ja_JP", intl: () => "en-US" }), "ja");
  });

  it("handles the script-tagged form AppleLocale can return", () => {
    assert.equal(detectLocale({ platform: "darwin", env: {}, run: () => "zh-Hans_US", intl: () => "en-US" }), "zh");
  });

  it("falls through to LANG, then Intl, when AppleLocale answers nothing", () => {
    assert.equal(detectLocale({ platform: "darwin", env: { LANG: "ko_KR.UTF-8" }, run: () => "  ", intl: () => "en-US" }), "ko");
    assert.equal(detectLocale({ platform: "darwin", env: {}, run: () => "", intl: () => "es-ES" }), "es");
  });
});
