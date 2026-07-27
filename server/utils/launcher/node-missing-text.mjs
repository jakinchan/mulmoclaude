// The "Node.js is missing" text, flattened for a shell stub.
//
// Shared by both generators. Each OS renders this screen natively
// (`display alert` / `MsgBox`) because it is the one screen that cannot
// be a web page — without node there is nothing to render one — but the
// WORDS must not fork: two copies would drift the moment either
// catalogue changed.
//
// A file rather than a generated string so translated prose never has
// to survive quoting into a shell AND into AppleScript / VBScript.

import { launcherMessages } from "./messages.mjs";

/**
 * @param {string} locale
 * @returns {string}
 */
export function renderNodeMissingText(locale) {
  const { nodeMissing } = launcherMessages(locale);
  // Line 1 is the title and line 2 starts the body — both stubs split on
  // exactly that, so a blank second line would open the alert with an
  // empty paragraph.
  return [nodeMissing.title, nodeMissing.body, "", nodeMissing.action, "", nodeMissing.hint].join("\n");
}
