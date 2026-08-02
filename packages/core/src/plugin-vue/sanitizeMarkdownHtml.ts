// Sanitize wrapper for `marked.parse` output, for the views that inject it with
// `v-html`.
//
// It matters more since presentDocument's `path` argument was widened: the
// markdown a view renders is no longer only what this app wrote — it can be any
// `.md` on disk, including a file that came with a repository the user cloned.
// Unsanitised, `<img src=x onerror=…>` in such a file would execute in the app's
// origin, which holds the session and can reach `/api/*`.
//
// The policy mirrors the host's own `src/utils/markdown/sanitize.ts` (skill
// bodies, text responses): DOMPurify's strict defaults, plus ONE tightly scoped
// exception for the YouTube embed the wiki renderer emits. Everything else with
// a different host — or a different path / query shape — is dropped by the
// `uponSanitizeElement` hook before DOMPurify's allow-list is consulted.
//
// Lives in core rather than in one plugin because both the markdown plugin's
// View and the hosts render the same `marked` output; a second copy of this
// policy is how one surface ends up laxer than the other.

import DOMPurify from "dompurify";

// Tight: no query string allowed — the embed helper always emits the no-params
// shape, so omitting the trailing `?…` group closes a ReDoS lint warning
// without losing real-world coverage.
const ALLOWED_IFRAME_SRC = /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/;

// `nodeType`, not `instanceof Element`: this package is also consumed outside a
// browser (the Node + jsdom test harness installs `window`/`document` but not
// the DOM constructors), where the bare `Element` global is a ReferenceError.
// nodeType 1 is the DOM standard's own element discriminant.
const ELEMENT_NODE = 1;
const isElementNode = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;

let hookInstalled = false;

function ensureHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "iframe") return;
    const src = isElementNode(node) ? node.getAttribute("src") : null;
    if (src === null || !ALLOWED_IFRAME_SRC.test(src)) {
      // Drop the iframe entirely — keeps the surrounding markdown, removes the
      // unsafe element.
      node.parentNode?.removeChild(node);
    }
  });
}

const SANITIZE_CONFIG = {
  ADD_TAGS: ["iframe"],
  ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "loading", "referrerpolicy"],
};

/** Sanitize HTML produced by `marked.parse`. Strips everything DOMPurify would
 *  normally strip; additionally permits the one YouTube-embed iframe shape. */
export function sanitizeMarkdownHtml(html: string): string {
  ensureHook();
  // DOMPurify's typed return is `string | TrustedHTML` depending on config
  // flags; `RETURN_TRUSTED_TYPE` is never enabled here, so it is always a
  // string. The double cast is the documented way to narrow through the union.
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
}

/** Test seam — undoes the global DOMPurify hook so an isolated test can verify
 *  the no-hook baseline. Production code never calls this. */
export function _resetSanitizeForTests(): void {
  DOMPurify.removeAllHooks();
  hookInstalled = false;
}
