// #470: dynamic favicon. Logo PNG has an opaque white backing; on first load we punch near-white pixels to alpha so
// the resolved color shows through. If the PNG fails to load we fall back to a plain colored square with letter "M".

import { watch, type Ref, type ComputedRef } from "vue";
import logoUrl from "../assets/mulmo_bw.png";
import { toError } from "../utils/errors";

const NOTIFICATION_DOT_COLOR = "#DC2626"; // red-600
const ACTIVE_SESSION_DOT_COLOR = "#EAB308"; // yellow-500
const SIZE = 32;
const RADIUS = 6;
// 2px on each side keeps the mascot off the rounded corners and lets the colored backing peek around the outline.
const MASCOT_INSET = 2;

// Threshold for "is this the PNG's white backing?" — the mascot uses soft pastels so it never hits all three channels this high.
const WHITE_TO_ALPHA_THRESHOLD = 235;
const FEATHER_LOW = 205;

let logoCanvas: HTMLCanvasElement | null = null;
let logoLoadFailed = false;
let logoLoadPromise: Promise<HTMLCanvasElement> | null = null;

function loadLogo(): Promise<HTMLCanvasElement> {
  if (logoCanvas) return Promise.resolve(logoCanvas);
  if (logoLoadPromise) return logoLoadPromise;
  logoLoadPromise = decodeAndPunchOutWhite();
  return logoLoadPromise;
}

function decodeAndPunchOutWhite(): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        logoCanvas = buildTransparentLogoCanvas(img);
        resolve(logoCanvas);
      } catch (err) {
        logoLoadFailed = true;
        reject(toError(err));
      }
    };
    img.onerror = (err) => {
      logoLoadFailed = true;
      reject(toError(err, "favicon logo failed to load"));
    };
    img.src = logoUrl;
  });
}

const RGBA_STRIDE = 4;
const OPAQUE_ALPHA = 255;

/** Near-white fades to transparent so the logo reads on any tab
 *  background; anything darker than the feather floor keeps the alpha
 *  it already has. */
function alphaForMinChannel(minChannel: number, currentAlpha: number): number {
  if (minChannel >= WHITE_TO_ALPHA_THRESHOLD) return 0;
  if (minChannel < FEATHER_LOW) return currentAlpha;
  const ratio = (minChannel - FEATHER_LOW) / (WHITE_TO_ALPHA_THRESHOLD - FEATHER_LOW);
  return Math.round(OPAQUE_ALPHA * (1 - ratio));
}

function punchOutWhite(pixels: Uint8ClampedArray): void {
  for (let offset = 0; offset < pixels.length; offset += RGBA_STRIDE) {
    // An RGBA buffer is always a whole number of 4-byte pixels, so these
    // reads are in range; the defaults leave a truncated tail untouched.
    const minChannel = Math.min(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
    pixels[offset + 3] = alphaForMinChannel(minChannel, pixels[offset + 3] ?? OPAQUE_ALPHA);
  }
}

function buildTransparentLogoCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  punchOutWhite(imageData.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, posX: number, posY: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(posX + radius, posY);
  ctx.lineTo(posX + width - radius, posY);
  ctx.quadraticCurveTo(posX + width, posY, posX + width, posY + radius);
  ctx.lineTo(posX + width, posY + height - radius);
  ctx.quadraticCurveTo(posX + width, posY + height, posX + width - radius, posY + height);
  ctx.lineTo(posX + radius, posY + height);
  ctx.quadraticCurveTo(posX, posY + height, posX, posY + height - radius);
  ctx.lineTo(posX, posY + radius);
  ctx.quadraticCurveTo(posX, posY, posX + radius, posY);
  ctx.closePath();
}

function drawLogoCentered(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, inset: number): void {
  const available = SIZE - inset * 2;
  const aspect = source.width / source.height;
  const drawW = aspect >= 1 ? available : available * aspect;
  const drawH = aspect >= 1 ? available / aspect : available;
  const drawX = inset + (available - drawW) / 2;
  const drawY = inset + (available - drawH) / 2;
  ctx.drawImage(source, drawX, drawY, drawW, drawH);
}

function drawCornerDot(ctx: CanvasRenderingContext2D, dotX: number, dotY: number, color: string): void {
  const dotR = 5;
  ctx.beginPath();
  ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawNotificationDot(ctx: CanvasRenderingContext2D): void {
  const dotR = 5;
  drawCornerDot(ctx, SIZE - dotR - 1, dotR + 1, NOTIFICATION_DOT_COLOR);
}

function drawActiveSessionDot(ctx: CanvasRenderingContext2D): void {
  const dotR = 5;
  drawCornerDot(ctx, dotR + 1, dotR + 1, ACTIVE_SESSION_DOT_COLOR);
}

function renderFallbackFavicon(ctx: CanvasRenderingContext2D, color: string, isRunning: boolean, hasNotification: boolean): void {
  drawRoundedRect(ctx, 1, 1, SIZE - 2, SIZE - 2, RADIUS);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.fillStyle = "white";
  ctx.font = "bold 20px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("M", SIZE / 2, SIZE / 2 + 1);

  if (isRunning) drawActiveSessionDot(ctx);
  if (hasNotification) drawNotificationDot(ctx);
}

function renderLogoFavicon(ctx: CanvasRenderingContext2D, logo: HTMLCanvasElement, color: string, isRunning: boolean, hasNotification: boolean): void {
  drawRoundedRect(ctx, 0, 0, SIZE, SIZE, RADIUS);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.save();
  drawRoundedRect(ctx, 0, 0, SIZE, SIZE, RADIUS);
  ctx.clip();
  drawLogoCentered(ctx, logo, MASCOT_INSET);
  ctx.restore();

  if (isRunning) drawActiveSessionDot(ctx);
  if (hasNotification) drawNotificationDot(ctx);
}

async function renderFavicon(color: string, isRunning: boolean, hasNotification: boolean): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  if (!logoLoadFailed) {
    try {
      const logo = await loadLogo();
      renderLogoFavicon(ctx, logo, color, isRunning, hasNotification);
      return canvas.toDataURL("image/png");
    } catch {
      // fall through to the fallback path
    }
  }

  renderFallbackFavicon(ctx, color, isRunning, hasNotification);
  return canvas.toDataURL("image/png");
}

function iconLinkElement(): HTMLLinkElement {
  const existing = document.querySelector("link[rel='icon']");
  if (existing instanceof HTMLLinkElement) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}

function applyFavicon(dataUrl: string): void {
  if (!dataUrl) return;
  const link = iconLinkElement();
  link.type = "image/png";
  link.href = dataUrl;
}

export interface DynamicFaviconOpts {
  color: Ref<string> | ComputedRef<string>;
  isRunning: Ref<boolean> | ComputedRef<boolean>;
  hasNotification: Ref<boolean> | ComputedRef<boolean>;
}

export function useDynamicFavicon(opts: DynamicFaviconOpts): void {
  async function update(): Promise<void> {
    const dataUrl = await renderFavicon(opts.color.value, opts.isRunning.value, opts.hasNotification.value);
    applyFavicon(dataUrl);
  }

  watch(
    [opts.color, opts.isRunning, opts.hasNotification],
    () => {
      update().catch((err) => console.warn("[favicon] render failed", err));
    },
    { immediate: true },
  );
}

// Re-exported so existing callers of this file keep working during the resolveColor split's transition.
export { FAVICON_STATES, type FaviconState } from "./favicon/types";
