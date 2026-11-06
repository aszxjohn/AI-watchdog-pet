/**
 * The placeholder tray icon (user decision 2026-11-06): a ring drawn in
 * code, until a real icon replaces it. It is drawn at 16 px and at the
 * sizes the 1.25x, 1.5x and 2x display scales use (20, 24, 32 px), so
 * Windows at 125 % or 150 % does not show a blurred, scaled-up ring.
 *
 * - macOS: black, marked as a template image, so the menu bar tints it for
 *   light and dark menu bars.
 * - Windows (and Linux): opaque mid-gray, which reads on both light and dark
 *   taskbars.
 */
import { nativeImage, type NativeImage } from 'electron';

/** Each representation: its size in pixels and the scale factor it is for. */
export const TRAY_ICON_REPRESENTATIONS = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
] as const;

/** Gray level of the Windows / Linux icon (0 black … 255 white). */
export const TRAY_ICON_GRAY = 128;

/** Ring radii as fractions of the icon size. */
const OUTER_RADIUS = 7 / 16;
const INNER_RADIUS = 4 / 16;
/** Samples per pixel side for anti-aliasing (4 x 4 = 16 samples). */
const SUPERSAMPLE = 4;

export interface TrayIconStyle {
  /** Gray level of every opaque pixel, 0 … 255. */
  readonly gray: number;
  /** Whether macOS should treat the image as a template. */
  readonly template: boolean;
}

export function trayIconStyle(platform: NodeJS.Platform): TrayIconStyle {
  return platform === 'darwin'
    ? { gray: 0, template: true }
    : { gray: TRAY_ICON_GRAY, template: false };
}

/**
 * A `size` x `size` ring as a raw bitmap for `nativeImage.createFromBitmap`:
 * 4 bytes per pixel, row by row, premultiplied alpha. Every colour channel
 * holds the same value, so the channel order (BGRA on macOS and Windows)
 * does not matter.
 */
export function drawRingBitmap(size: number, gray: number): Buffer {
  const bitmap = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const outer = size * OUTER_RADIUS;
  const inner = size * INNER_RADIUS;
  const step = 1 / SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const dx = x + (sx + 0.5) * step - center;
          const dy = y + (sy + 0.5) * step - center;
          const distance = Math.hypot(dx, dy);
          if (distance <= outer && distance >= inner) {
            covered += 1;
          }
        }
      }
      const alpha = Math.round((covered * 255) / (SUPERSAMPLE * SUPERSAMPLE));
      const channel = Math.round((gray * alpha) / 255);
      const offset = (y * size + x) * 4;
      bitmap[offset] = channel;
      bitmap[offset + 1] = channel;
      bitmap[offset + 2] = channel;
      bitmap[offset + 3] = alpha;
    }
  }
  return bitmap;
}

/** The tray icon for `platform`, with every TRAY_ICON_REPRESENTATIONS size. */
export function createTrayIcon(platform: NodeJS.Platform): NativeImage {
  const { gray, template } = trayIconStyle(platform);
  const [base, ...others] = TRAY_ICON_REPRESENTATIONS;
  const image = nativeImage.createFromBitmap(drawRingBitmap(base.size, gray), {
    width: base.size,
    height: base.size,
    scaleFactor: base.scaleFactor,
  });
  for (const { size, scaleFactor } of others) {
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: drawRingBitmap(size, gray),
    });
  }
  if (template) {
    image.setTemplateImage(true);
  }
  return image;
}
