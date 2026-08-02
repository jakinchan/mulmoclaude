import { parse, type HTMLElement } from "node-html-parser";

// A local resource referenced by the HTML that must be copied into the
// bundle. `originalRef` is the reference verbatim as it appears in the
// source (relative to the HTML file); `bundlePath` is where it lands in
// the self-contained bundle (always under `assets/`).
export interface AssetRef {
  originalRef: string;
  bundlePath: string;
}

export interface RewriteResult {
  html: string;
  assets: AssetRef[];
}

const ASSETS_DIR = "assets";

// Refs we never bundle: absolute URLs, protocol-relative, data/blob,
// in-page anchors, and non-navigational schemes. Everything else is a
// workspace-relative path the bundle must localize. Root-absolute
// (`/foo`) is left alone too — without a known base it can't be mapped.
function isLocalRef(ref: string): boolean {
  const value = ref.trim();
  if (value === "") return false;
  if (value.startsWith("#") || value.startsWith("//") || value.startsWith("/")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function stripQueryHash(ref: string): string {
  const cut = ref.search(/[?#]/);
  return cut === -1 ? ref : ref.slice(0, cut);
}

// Safe single-segment filename for a bundle entry. Splits on BOTH path
// separators — a crafted `..\..\evil.png` must not survive into a zip
// entry name, where a Windows unzip tool treats `\` as a separator
// (zip-slip). `.`/`..`/empty collapse to a neutral name.
function safeAssetName(ref: string): string {
  const segment = stripQueryHash(ref).split(/[/\\]/).pop() ?? "";
  return segment === "" || segment === "." || segment === ".." ? "asset" : segment;
}

function splitSuffix(ref: string): { filePath: string; suffix: string } {
  const cut = ref.search(/[?#]/);
  return cut === -1 ? { filePath: ref, suffix: "" } : { filePath: ref.slice(0, cut), suffix: ref.slice(cut) };
}

// Maps a local ref to its `assets/<name>` slot. The bundled FILE is
// keyed by the path with `?query`/`#fragment` stripped, so `a.png?v=1`
// and `a.png?v=2` share one copy; but the rewritten URL keeps each
// ref's suffix (an SVG `sprite.svg#icon` fragment must survive). A
// basename collision across different dirs is disambiguated by a short
// hash of the file path so two `logo.png` don't clobber each other.
function createAssetMapper() {
  const byPath = new Map<string, string>();
  const usedNames = new Set<string>();
  const assets: AssetRef[] = [];

  const hash = (value: string): string => {
    let acc = 0;
    for (const char of value) acc = (acc * 31 + char.charCodeAt(0)) | 0;
    return (acc >>> 0).toString(36);
  };

  const bundlePathFor = (filePath: string): string => {
    const existing = byPath.get(filePath);
    if (existing) return existing;
    const base = safeAssetName(filePath);
    const name = usedNames.has(base) ? `${hash(filePath)}-${base}` : base;
    usedNames.add(name);
    const bundlePath = `${ASSETS_DIR}/${name}`;
    byPath.set(filePath, bundlePath);
    assets.push({ originalRef: filePath, bundlePath });
    return bundlePath;
  };

  const map = (originalRef: string): string => {
    const { filePath, suffix } = splitSuffix(originalRef);
    return bundlePathFor(filePath) + suffix;
  };

  return { map, assets };
}

function rewriteCssUrls(css: string, map: (ref: string) => string): string {
  return css.replace(/url\(([^)]*)\)/gi, (whole, inner: string) => {
    const raw = inner.trim();
    const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : "";
    const ref = quote ? raw.slice(1, -1) : raw;
    if (!isLocalRef(ref)) return whole;
    return `url(${quote}${map(ref)}${quote})`;
  });
}

function isSrcsetWs(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

// One srcset candidate: a URL (a run of non-whitespace, so a data: URI's
// internal commas stay intact) whose trailing commas are separators, then
// an optional descriptor up to the next comma. Only local URLs are
// rewritten; everything else is emitted verbatim. Returns the new cursor.
function rewriteSrcsetCandidate(value: string, start: number, map: (ref: string) => string, out: string[]): number {
  let index = start;
  while (index < value.length && !isSrcsetWs(value[index])) index++;
  let url = value.slice(start, index);
  let trailing = "";
  while (url.endsWith(",")) {
    url = url.slice(0, -1);
    trailing += ",";
  }
  out.push(isLocalRef(url) ? map(url) : url, trailing);
  if (trailing !== "") return index;
  const descStart = index;
  while (index < value.length && value[index] !== ",") index++;
  out.push(value.slice(descStart, index));
  return index;
}

// WHATWG-style srcset walk: candidates are comma-separated, but because a
// URL is a non-whitespace run, `data:` URIs (whose payload contains commas)
// are never split. Separators / whitespace / descriptors are preserved.
function rewriteSrcset(value: string, map: (ref: string) => string): string {
  const out: string[] = [];
  let index = 0;
  while (index < value.length) {
    const sepStart = index;
    while (index < value.length && (isSrcsetWs(value[index]) || value[index] === ",")) index++;
    out.push(value.slice(sepStart, index));
    if (index < value.length) index = rewriteSrcsetCandidate(value, index, map, out);
  }
  return out.join("");
}

// Embedded resources only. `a[href]` is intentionally excluded — it is
// navigation, not an inlined asset, and rewriting it would point at a
// file the single-page bundle doesn't carry.
const URL_ATTRS: readonly { selector: string; attr: string }[] = [
  { selector: "img[src]", attr: "src" },
  { selector: "script[src]", attr: "src" },
  { selector: "source[src]", attr: "src" },
  { selector: "link[href]", attr: "href" },
  { selector: "audio[src]", attr: "src" },
  { selector: "video[src]", attr: "src" },
  { selector: "video[poster]", attr: "poster" },
  { selector: "use[href]", attr: "href" },
];

function rewriteAttrs(root: HTMLElement, map: (ref: string) => string): void {
  for (const { selector, attr } of URL_ATTRS) {
    for (const element of root.querySelectorAll(selector)) {
      const ref = element.getAttribute(attr);
      if (ref && isLocalRef(ref)) element.setAttribute(attr, map(ref));
    }
  }
  for (const element of root.querySelectorAll("[srcset]")) {
    const value = element.getAttribute("srcset");
    if (value) element.setAttribute("srcset", rewriteSrcset(value, map));
  }
  for (const element of root.querySelectorAll("style")) {
    element.set_content(rewriteCssUrls(element.textContent, map));
  }
  for (const element of root.querySelectorAll("[style]")) {
    const value = element.getAttribute("style");
    if (value) element.setAttribute("style", rewriteCssUrls(value, map));
  }
}

// Rewrites every local resource reference in `html` to point at a
// co-located `assets/<name>`, returning the rewritten document plus the
// list of refs to copy. Pure: no filesystem or network.
export function rewriteHtmlAssets(html: string): RewriteResult {
  const root = parse(html, { comment: true });
  const mapper = createAssetMapper();
  rewriteAttrs(root, mapper.map);
  return { html: root.toString(), assets: mapper.assets };
}
