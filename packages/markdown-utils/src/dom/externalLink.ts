// Click handler for rendered markdown / HTML bodies that opens
// external (cross-origin) http(s) links in a new tab instead of
// navigating the SPA away from itself.
//
// Split into a pure predicate (`isCrossOriginHttpUrl`) that's
// exhaustively unit-tested, and a thin DOM wrapper
// (`handleExternalLinkClick`) that reads the click event. Callers
// invoke the wrapper from their own `@click` handler and check the
// return value to decide whether to fall through to plugin-specific
// navigation.

// `nodeType`, not `instanceof Element`: this package is also consumed outside a
// browser (the Node + jsdom test harness installs `window`/`document` but not
// the DOM constructors), where the bare `Element` global is a ReferenceError.
// nodeType 1 is the DOM standard's own element discriminant, and it stops at
// Element rather than HTMLElement because an inline <svg> inside a link is a
// legitimate click target that must still resolve to its anchor.
const ELEMENT_NODE = 1;
const isElementNode = (target: EventTarget | null): target is Element => target !== null && "nodeType" in target && target.nodeType === ELEMENT_NODE;

// Pure predicate: is `href` an absolute http(s) URL pointing at an
// origin different from `currentOrigin`? Used by
// `handleExternalLinkClick` below, and directly by tests.
//
// Returns `false` for:
//   - non-http schemes (mailto:, tel:, javascript:, file: …) — the
//     browser's default behaviour is appropriate for those
//   - same-origin URLs (including hash anchors resolved against the
//     current page, which `anchor.href` normalises to a full URL)
//   - malformed input that `URL` can't parse
export function isCrossOriginHttpUrl(href: string, currentOrigin: string): boolean {
  if (!href.startsWith("http://") && !href.startsWith("https://")) {
    return false;
  }
  try {
    return new URL(href).origin !== currentOrigin;
  } catch {
    return false;
  }
}

// DOM click handler. Invoke from a view's `@click` listener on a
// rendered-markdown container. If the event targets an external
// http(s) link, the default navigation is cancelled and the link
// opens in a new tab with `noopener,noreferrer`; returns `true` so
// the caller knows the click was consumed. Returns `false` for
// every other case (not an anchor, internal link, modifier-key
// click, non-left-button, …) so the caller can continue with its
// own plugin-specific click handling (e.g. wiki internal links).
export function handleExternalLinkClick(event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const { target } = event;
  if (!isElementNode(target)) return false;
  const anchor = target.closest("a");
  if (!anchor) return false;
  // `.href` (DOM property) is always a fully-resolved URL; contrast
  // `getAttribute("href")` which returns the raw attribute string.
  // Using the resolved form gives us reliable origin checks and
  // normalises relative paths away.
  const url = anchor.href;
  if (!isCrossOriginHttpUrl(url, window.location.origin)) return false;
  event.preventDefault();
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
