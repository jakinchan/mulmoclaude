// Tests for `server/utils/launcher/launcher-page.mjs` — the two pages
// the launcher can put on screen before the app is reachable.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, linkify, renderErrorPage, renderLauncherPage } from "../../../server/utils/launcher/launcher-page.mjs";
import { launcherMessages } from "../../../server/utils/launcher/messages.mjs";

const messages = launcherMessages("en");

describe("escapeHtml", () => {
  it("escapes the ampersand before the escapes it introduces", () => {
    assert.equal(escapeHtml("a & <b>"), "a &amp; &lt;b&gt;");
  });

  it("escapes quotes so a value cannot break out of an attribute", () => {
    assert.equal(escapeHtml(`" onload="x`), "&quot; onload=&quot;x");
  });
});

describe("linkify", () => {
  it("turns a URL into a link", () => {
    assert.equal(
      linkify("Install from https://nodejs.org/ first"),
      'Install from <a href="https://nodejs.org/" target="_blank" rel="noreferrer noopener">https://nodejs.org/</a> first',
    );
  });

  it("stops the link at the URL when CJK text follows without a space", () => {
    const html = linkify("https://nodejs.org/から入れてください");
    assert.match(html, />https:\/\/nodejs\.org\/<\/a>から入れてください$/);
  });

  it("leaves a trailing sentence period outside the link", () => {
    assert.match(linkify("see https://example.com/a."), />https:\/\/example\.com\/a<\/a>\.$/);
  });

  it("still escapes the surrounding text", () => {
    assert.match(linkify("<b> https://example.com/"), /^&lt;b&gt; /);
  });

  it("passes through text with no URL", () => {
    assert.equal(linkify("nothing to see"), "nothing to see");
  });
});

describe("renderLauncherPage", () => {
  const page = renderLauncherPage({ messages, port: 3001, logPath: "/tmp/launcher.log", locale: "en" });

  it("polls and redirects to the port it was given", () => {
    assert.match(page, /const PORT = 3001;/);
    assert.match(page, /mode: "no-cors"/);
    assert.match(page, /location\.replace\("http:\/\/localhost:" \+ PORT/);
  });

  it("ships the failure state hidden, ready to reveal without another page load", () => {
    assert.match(page, /<div id="state-failed" hidden>/);
  });

  it("fills the {seconds} placeholder rather than showing it raw", () => {
    assert.ok(!page.includes("{seconds}"));
    assert.match(page, /120/);
  });

  it("links to the log file", () => {
    assert.match(page, /href="file:\/\/\/tmp\/launcher\.log"/);
  });

  it("refuses a port that could never be valid", () => {
    [0, 70000, 3001.5, Number.NaN].forEach((port) => {
      assert.throws(() => renderLauncherPage({ messages, port, logPath: "/tmp/x.log", locale: "en" }), /invalid port/);
    });
  });

  it("percent-encodes a log path with a space so the href stays one URL", () => {
    const spacedPath = renderLauncherPage({ messages, port: 3001, logPath: "/tmp/my logs/launcher.log", locale: "en" });
    assert.match(spacedPath, /href="file:\/\/\/tmp\/my%20logs\/launcher\.log"/);
  });
});

describe("renderErrorPage", () => {
  it("renders the install commands as separate copyable lines", () => {
    const page = renderErrorPage({ messages, failure: messages.claudeMissing, logPath: "/tmp/x.log", locale: "en" });
    assert.match(page, /<code>npm install -g @anthropic-ai\/claude-code<\/code>/);
    assert.match(page, /<code>claude<\/code>/);
    assert.match(page, /user-select: all/);
  });

  it("has no polling script — this page is a dead end by design", () => {
    const page = renderErrorPage({ messages, failure: messages.claudeMissing, logPath: "/tmp/x.log", locale: "en" });
    assert.ok(!page.includes("<script>"));
  });

  it("omits the steps list when a failure has none", () => {
    const page = renderErrorPage({ messages, failure: messages.nodeTooOld, logPath: "/tmp/x.log", locale: "en" });
    assert.ok(!page.includes("<ol"));
  });

  it("renders the hint of the node-missing case", () => {
    const page = renderErrorPage({ messages, failure: messages.nodeMissing, logPath: "/tmp/x.log", locale: "en" });
    assert.match(page, /npx mulmoclaude@latest/);
  });

  it("declares the locale it was rendered in", () => {
    const page = renderErrorPage({ messages: launcherMessages("ja"), failure: launcherMessages("ja").nodeTooOld, logPath: "", locale: "ja" });
    assert.match(page, /<html lang="ja">/);
  });
});
