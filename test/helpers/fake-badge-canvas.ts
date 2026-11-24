/**
 * Stand-ins for the 2D canvas the name tags (Story 3.8) are measured and
 * painted on, which Node does not have:
 *
 * - recordingBadgeContext() writes down what is painted with it, in order,
 *   one line per call (the styles each uses written out), and measures a
 *   text FAKE_CHAR_WIDTH DIP per code point, whatever its font.
 * - fakeBadgeCanvases() makes canvases with such a context, in order made;
 *   setting a size clears what was written down, as a real canvas clears.
 */
import type {
  BadgeCanvas,
  BadgeContext,
} from '../../src/overlay/renderer/badges';

/** How wide each code point is measured, DIP. */
export const FAKE_CHAR_WIDTH = 6;

/** A 2D context that writes down what is painted with it in `calls`. */
export function recordingBadgeContext(calls: string[]): BadgeContext {
  const context: BadgeContext = {
    font: '10px sans-serif',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    setTransform: (a, b, c, d, e, f) =>
      calls.push(`setTransform ${a} ${b} ${c} ${d} ${e} ${f}`),
    beginPath: () => calls.push('beginPath'),
    roundRect: (x, y, width, height, radii) =>
      calls.push(`roundRect ${x} ${y} ${width} ${height} ${radii}`),
    arc: (x, y, radius, start, end) =>
      calls.push(`arc ${x} ${y} ${radius} ${start} ${end}`),
    fill: () => calls.push(`fill ${String(context.fillStyle)}`),
    stroke: () =>
      calls.push(`stroke ${String(context.strokeStyle)} ${context.lineWidth}`),
    fillText: (text, x, y) =>
      calls.push(
        `fillText ${JSON.stringify(text)} ${x} ${y} ${String(context.fillStyle)} ${context.font} ${context.textAlign} ${context.textBaseline}`,
      ),
    measureText: (text) => ({
      width: Array.from(text).length * FAKE_CHAR_WIDTH,
    }),
  };
  return context;
}

/** One canvas made, and what was painted on it since it was last sized. */
export interface MadeBadgeCanvas {
  readonly canvas: BadgeCanvas;
  readonly calls: string[];
}

/** Canvases that write down what is painted on them, in order made. */
export function fakeBadgeCanvases(
  options: { readonly noContext?: boolean } = {},
) {
  const made: MadeBadgeCanvas[] = [];
  return {
    made,
    create: (): BadgeCanvas => {
      const calls: string[] = [];
      const context = recordingBadgeContext(calls);
      let width = 300;
      let height = 150;
      const canvas: BadgeCanvas = {
        get width() {
          return width;
        },
        set width(value) {
          width = value;
          calls.length = 0;
        },
        get height() {
          return height;
        },
        set height(value) {
          height = value;
          calls.length = 0;
        },
        getContext: () => (options.noContext === true ? null : context),
      };
      made.push({ canvas, calls });
      return canvas;
    },
  };
}
