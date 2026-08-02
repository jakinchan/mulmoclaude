// Unit tests for the shared `confirmItemDelete` gate. Asserts that
// the helper is a pure pass-through to `window.confirm` so callers
// can rely on it as the single seam for destructive item prompts.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { confirmItemDelete } from "../../src/utils/confirmDelete";

interface MinimalWindow {
  confirm: (message?: string) => boolean;
}

let originalWindow: MinimalWindow | undefined;
let lastMessage: string | undefined;
let nextResult = true;

describe("confirmItemDelete", () => {
  before(() => {
    originalWindow = (globalThis as { window?: MinimalWindow | undefined }).window;
    (globalThis as { window?: MinimalWindow | undefined }).window = {
      confirm: (message?: string) => {
        lastMessage = message;
        return nextResult;
      },
    };
  });

  after(() => {
    (globalThis as { window?: MinimalWindow | undefined }).window = originalWindow;
  });

  beforeEach(() => {
    lastMessage = undefined;
    nextResult = true;
  });

  it("returns true when the user accepts", () => {
    nextResult = true;
    assert.equal(confirmItemDelete("Delete?"), true);
  });

  it("returns false when the user dismisses", () => {
    nextResult = false;
    assert.equal(confirmItemDelete("Delete?"), false);
  });

  it("forwards the message string verbatim", () => {
    const msg = 'Delete "Q3 review" — 100%?';
    confirmItemDelete(msg);
    assert.equal(lastMessage, msg);
  });

  it("handles empty message", () => {
    confirmItemDelete("");
    assert.equal(lastMessage, "");
  });
});
