import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findIconElements } from "./iconFontProbe.js";

const sfc = (template: string) => `<template>\n${template}\n</template>\n`;

describe("findIconElements", () => {
  it("pairs the font class with the name on the SAME element", () => {
    // The whole point of parsing: a grep would see "material-icons" and
    // "progress_activity" in this template and could not tell they belong
    // to different elements.
    const found = findIconElements(
      sfc(`<div>
        <span class="material-icons text-sm">refresh</span>
        <span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
      </div>`),
    );
    assert.deepEqual(found, [
      { fontClass: "material-icons", name: "refresh" },
      { fontClass: "material-symbols-outlined", name: "progress_activity" },
    ]);
  });

  it("reports an interpolated name as null — schema data is not knowable from source", () => {
    const found = findIconElements(sfc(`<span class="material-icons text-sm">{{ action.icon }}</span>`));
    assert.deepEqual(found, [{ fontClass: "material-icons", name: null }]);
  });

  it("finds icons nested at any depth, and ignores elements without a font class", () => {
    const found = findIconElements(
      sfc(`<div class="wrapper">
        <button><span class="text-sm">not an icon</span></button>
        <ul><li><span class="material-icons">delete</span></li></ul>
      </div>`),
    );
    assert.deepEqual(found, [{ fontClass: "material-icons", name: "delete" }]);
  });

  it("is not fooled by a class that merely contains the font name", () => {
    const found = findIconElements(sfc(`<span class="not-material-icons-really">refresh</span>`));
    assert.deepEqual(found, []);
  });

  it("returns nothing for an SFC with no template", () => {
    assert.deepEqual(findIconElements(`<script setup lang="ts">const a = 1;</script>\n`), []);
  });
});
