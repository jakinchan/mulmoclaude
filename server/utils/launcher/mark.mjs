// The launcher's artwork, shared by the macOS .icns and the Windows .ico.
//
// The same mark the web app uses for its favicon (see index.html): a
// rounded grey square with a white M. Drawn as a stroked path rather
// than an SVG <text> element — text would depend on whichever font the
// rasteriser happens to pick, and the mark has to look identical on
// every machine.
//
// One copy on purpose: two icon generators drifting apart would mean
// the same app wearing two faces depending on which OS produced it.

const CANVAS = 1024;
const MARK_BACKGROUND = "#6B7280";
// The mark sits inset from the canvas edge; ~9% keeps it clear of the
// Dock's own spacing without looking lost.
const INSET = 96;
const CORNER_RADIUS = 208;

/** The mark as a standalone SVG document. */
export function markSvg() {
  const size = CANVAS - INSET * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect x="${INSET}" y="${INSET}" width="${size}" height="${size}" rx="${CORNER_RADIUS}" fill="${MARK_BACKGROUND}"/>
  <path d="M 300 690 L 300 340 L 512 560 L 724 340 L 724 690" fill="none" stroke="#ffffff"
        stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
