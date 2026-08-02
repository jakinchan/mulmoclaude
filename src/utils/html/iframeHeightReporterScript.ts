import { injectBeforeBodyClose } from "./injectBeforeBodyClose";

// Tiny inline script injected into every `/artifacts/html/...` document
// so the parent (StackView in chat) can size each iframe to its
// rendered content height — despite the sandbox treating the iframe as
// cross-origin (#1219 follow-up).
//
// Why this matters: presentHtml's iframe runs with
// `sandbox="allow-scripts"` (deliberate — `allow-same-origin` would let
// LLM-generated HTML read the parent's cookies / localStorage / bearer
// token). Without `allow-same-origin`, the parent's
// `iframe.contentDocument.documentElement.scrollHeight` access throws
// cross-origin, leaving the iframe at the browser-default 150px and
// clipping the actual chart / Sankey / report inside.
//
// The reporter runs INSIDE the iframe (under its null origin), reads
// only its own document height, and posts a message to its parent. The
// parent then sets `iframe.style.height` from the reported value. No
// parent state is exposed to the iframe.
//
// Posts on initial `load`, on every subsequent body resize (charts that
// populate after DOMContentLoaded, web-font settling, etc.), and once
// more on `DOMContentLoaded` so the first paint is also sized.
//
// On iframe WIDTH changes:
//
// 1. Fires a synthetic `window.resize` event so libraries hooked into
//    that signal (Chart.js, ECharts, custom code) get the nudge.
// 2. Calls `Plotly.Plots.resize` on every `.js-plotly-plot` /
//    `.plotly-graph-div` element if Plotly is loaded. Plotly v2's
//    `responsive: true` is supposed to catch this via its own
//    ResizeObserver, but in the sandboxed iframe context the observer
//    sometimes misses the change. Calling resize directly is the
//    documented escape hatch and a no-op when the chart was already
//    correctly sized. Gated on `window.Plotly` so HTML pages without
//    Plotly are unaffected.
//
// Pairs with the listener in `src/components/StackView.vue`. Message
// shape: `{ type: "mc-iframe-height", height: <pixels> }`. The listener
// matches the iframe via `event.source === iframe.contentWindow`, then
// `iframe.style.setProperty("height", "<n>px", "important")` (the
// `!important` defeats the stack-natural `:deep(.h-full)` override).

const REPORTER_SCRIPT = `(()=>{const p=()=>{try{parent.postMessage({type:"mc-iframe-height",height:document.documentElement.scrollHeight},"*")}catch(e){}};const r=()=>{try{window.dispatchEvent(new Event("resize"))}catch(e){}try{const P=window.Plotly;if(P&&P.Plots&&P.Plots.resize){document.querySelectorAll(".js-plotly-plot,.plotly-graph-div").forEach(el=>{try{P.Plots.resize(el)}catch(e){}})}}catch(e){}};addEventListener("DOMContentLoaded",p);addEventListener("load",p);if(window.ResizeObserver&&document.documentElement){let w=0;new ResizeObserver((es)=>{p();const nw=es[0]&&es[0].contentRect?es[0].contentRect.width:0;if(nw&&nw!==w){w=nw;r()}}).observe(document.documentElement)}})();`;

export const HEIGHT_REPORTER_SCRIPT_TAG = `<script>${REPORTER_SCRIPT}</script>`;

/** Splice the height-reporter `<script>` tag immediately before the
 *  document's last `</body>`. Pure string operation — no DOM parsing,
 *  linear time in input length, idempotent in effect (the script is
 *  one-shot; duplicates produce duplicate postMessages, the parent
 *  listener handles them identically). When `</body>` is missing
 *  (server-streamed HTML, partial output, hand-written fragment), the
 *  tag is appended at the end so the script still loads. */
export function injectHeightReporterScript(html: string): string {
  return injectBeforeBodyClose(html, HEIGHT_REPORTER_SCRIPT_TAG);
}
