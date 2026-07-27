// The two pages the icon launcher can put on screen: "starting…" while
// the server boots, and a failure page when it cannot get there.
//
// Rendered to a single self-contained file and opened over `file://`,
// because they have to be visible BEFORE the server exists — there is
// nothing to serve them from. Everything is inlined for the same reason:
// a `file://` page cannot import a sibling ES module (Chrome treats it
// as cross-origin), and there is no network to fetch anything from.
//
// Styling is a plain <style> block rather than Tailwind utilities (see
// the styling rules in CLAUDE.md): this document is outside the Vite app
// entirely — no build step reaches it and no CDN is available offline.
//
// A browser page rather than an `osascript` dialog for prerequisite
// failures, because the fix for "Claude Code is missing" is a command
// the user has to run — and text in a native alert cannot be selected
// or copied. The one failure that still needs a native dialog is a
// missing Node.js, since without node nothing here can run at all.

import { fileUrl } from "./platform.mjs";

const POLL_INTERVAL_MS = 500;
const GIVE_UP_AFTER_MS = 120_000;

/**
 * `&` first, or the escapes escape each other.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Seconds the progress page waits before declaring the start failed. */
export function giveUpAfterSeconds() {
  return Math.round(GIVE_UP_AFTER_MS / 1000);
}

// Conservative on purpose: an ASCII-only tail, so a URL that runs
// straight into CJK text ("https://nodejs.org/ から") does not swallow
// the sentence after it.
const URL_PATTERN = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
const TRAILING_PUNCTUATION = ".,;:!?)";

// Trimmed by walking the end rather than with an anchored `[...]+$`
// regex, which backtracks super-linearly on a long tail.
function stripTrailingPunctuation(url) {
  const last = url.at(-1);
  if (last === undefined || !TRAILING_PUNCTUATION.includes(last)) return url;
  return stripTrailingPunctuation(url.slice(0, -1));
}

function anchor(url) {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)}</a>`;
}

/**
 * Escape `text` and turn any URL in it into a link. The instructions on
 * these pages point at nodejs.org, and a beginner who cannot open a
 * terminal should not have to retype a URL by hand either.
 * @param {string} text
 * @returns {string}
 */
export function linkify(text) {
  const source = String(text);
  const links = [...source.matchAll(URL_PATTERN)].map((match) => ({
    index: match.index,
    url: stripTrailingPunctuation(match[0]),
  }));
  const { html, cursor } = links.reduce(
    (acc, link) => ({
      html: acc.html + escapeHtml(source.slice(acc.cursor, link.index)) + anchor(link.url),
      cursor: link.index + link.url.length,
    }),
    { html: "", cursor: 0 },
  );
  return html + escapeHtml(source.slice(cursor));
}

/**
 * Progress page: polls until the server answers, then navigates to it.
 *
 * Liveness is polled with `fetch(..., {mode:"no-cors"})`, which resolves
 * opaquely when something answers and throws when nothing is listening —
 * verified in Chromium and WebKit from a real `file://` origin. It can
 * only say "someone answered", not who; that is fine, because the
 * launcher already established this port is ours before opening the page.
 *
 * @param {import("./launcher-page.d.mts").LauncherPageOptions} options
 * @returns {string}
 */
export function renderLauncherPage({ messages, port, logPath, locale }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`renderLauncherPage: invalid port ${port}`);
  }
  const failure = messages.startFailed;
  const body = `
  <div id="state-starting">
    <div class="spinner" role="progressbar" aria-label="${escapeHtml(messages.starting.title)}"></div>
    <h1>${escapeHtml(messages.starting.title)}</h1>
    <p>${escapeHtml(messages.starting.detail)}</p>
    <p class="muted">${escapeHtml(messages.starting.firstRun)}</p>
  </div>
  <div id="state-failed" hidden>
    <h1>${escapeHtml(failure.title)}</h1>
    <p>${linkify(fillSeconds(failure.body))}</p>
    <p class="action">${linkify(failure.action)}</p>
    ${logLink(messages, logPath)}
    <button type="button" id="retry">${escapeHtml(messages.retry)}</button>
  </div>`;
  return page({ locale, title: messages.starting.title, body, script: pollScript(port) });
}

/**
 * Failure page for a prerequisite that cannot be satisfied from here.
 * `steps` renders as copyable command lines.
 *
 * @param {import("./launcher-page.d.mts").ErrorPageOptions} options
 * @returns {string}
 */
export function renderErrorPage({ messages, failure, logPath, locale }) {
  const body = `
  <div>
    <h1>${escapeHtml(failure.title)}</h1>
    <p>${linkify(failure.body)}</p>
    <p class="action">${linkify(failure.action)}</p>
    ${renderSteps(failure.steps)}
    ${failure.stepsNote ? `<p class="muted">${linkify(failure.stepsNote)}</p>` : ""}
    ${failure.hint ? `<p class="muted">${linkify(failure.hint)}</p>` : ""}
    ${logLink(messages, logPath)}
  </div>`;
  return page({ locale, title: failure.title, body, script: "" });
}

function renderSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "";
  const items = steps.map((step) => `<li><code>${escapeHtml(step)}</code></li>`).join("");
  return `<ol class="steps">${items}</ol>`;
}

function logLink(messages, logPath) {
  if (!logPath) return "";
  const href = escapeHtml(fileUrl(logPath));
  return `<p class="muted">${escapeHtml(messages.log.label)}: <a href="${href}">${escapeHtml(messages.log.reveal)}</a></p>`;
}

// `{seconds}` is the only placeholder on the progress page and its value
// is fixed by GIVE_UP_AFTER_MS, so it is filled here rather than asking
// callers to pass a number they cannot know.
function fillSeconds(template) {
  return template.replace("{seconds}", String(giveUpAfterSeconds()));
}

const PAGE_STYLES = `
:root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1f2328; --muted: #6b7280; --card: #ffffff; --line: #e5e7eb; --code: #f3f4f6; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #17181c; --fg: #e8eaed; --muted: #9aa1ab; --card: #202127; --line: #33353d; --code: #2a2c33; }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "Hiragino Sans", "Noto Sans JP", sans-serif;
}
.card { width: min(32rem, calc(100vw - 2rem)); padding: 2.5rem 2rem; background: var(--card); border: 1px solid var(--line); border-radius: 0.9rem; text-align: center; }
.mark { width: 3rem; height: 3rem; margin: 0 auto 1.5rem; border-radius: 0.75rem; background: #6b7280; color: #fff; font-weight: 700; font-size: 1.75rem; line-height: 3rem; }
h1 { margin: 0 0 0.75rem; font-size: 1.15rem; font-weight: 600; }
p { margin: 0 0 0.6rem; font-size: 0.9rem; line-height: 1.6; }
.muted { color: var(--muted); font-size: 0.82rem; }
.action { font-weight: 500; }
a { color: inherit; }
.steps { margin: 0 0 0.8rem; padding: 0; list-style: none; text-align: left; }
.steps li { margin: 0.4rem 0; }
.steps code {
  display: block; padding: 0.55rem 0.7rem; background: var(--code); border: 1px solid var(--line); border-radius: 0.45rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; user-select: all; overflow-wrap: anywhere;
}
.spinner { width: 1.5rem; height: 1.5rem; margin: 0 auto 1.25rem; border: 2px solid var(--line); border-top-color: var(--muted); border-radius: 50%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
button { margin-top: 1rem; padding: 0.5rem 1.1rem; font: inherit; font-size: 0.88rem; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 0.5rem; cursor: pointer; }
button:hover { border-color: var(--muted); }
`;

function page({ locale, title, body, script }) {
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<main class="card">
  <div class="mark">M</div>${body}
</main>
${script ? `<script>${script}</script>` : ""}
</body>
</html>
`;
}

function pollScript(port) {
  return `
const PORT = ${port};
const INTERVAL_MS = ${POLL_INTERVAL_MS};
const GIVE_UP_MS = ${GIVE_UP_AFTER_MS};
const starting = document.getElementById("state-starting");
const failed = document.getElementById("state-failed");
let deadline = Date.now() + GIVE_UP_MS;

const show = (element) => {
  starting.hidden = element !== starting;
  failed.hidden = element !== failed;
};

const poll = async () => {
  try {
    await fetch("http://127.0.0.1:" + PORT + "/api/health", { mode: "no-cors", cache: "no-store" });
    location.replace("http://localhost:" + PORT + "/");
    return;
  } catch {
    if (Date.now() > deadline) {
      show(failed);
      return;
    }
    setTimeout(poll, INTERVAL_MS);
  }
};

document.getElementById("retry").addEventListener("click", () => {
  deadline = Date.now() + GIVE_UP_MS;
  show(starting);
  poll();
});

poll();
`;
}
