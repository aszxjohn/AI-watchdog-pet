/**
 * overlay/renderer (Story 3.7): the stage's own placeholder, drawn for an
 * actor whose state its character neither draws (`states`) nor maps
 * (`fallback`). Plain numbers: no PixiJS and no DOM, so it is unit-tested
 * under Node; pixi-stage.ts draws it.
 *
 * - A half-clear grey figure, a round head over a rounded body, filling
 *   the character's `hitbox` (in the actor's local coordinates):
 *   placeholderShape(). The same for every state (Story 3.8's badge tells
 *   them apart). Nothing is loaded for it.
 * - Its opacity rises and falls once every PLACEHOLDER_PERIOD_MS, between
 *   PLACEHOLDER_ALPHA_MIN and PLACEHOLDER_ALPHA_MAX, by the render loop's
 *   time (placeholderAlpha(): full at 0), so it stands still while the
 *   render loop does.
 */
import type { LocalBox } from '../../shared/pack-api';

/** Its colour (0xrrggbb): a mid grey, seen on light and dark desktops. */
export const PLACEHOLDER_COLOR = 0x9e9e9e;

/** Its opacity at its faintest. */
export const PLACEHOLDER_ALPHA_MIN = 0.35;

/** Its opacity at its fullest. */
export const PLACEHOLDER_ALPHA_MAX = 0.7;

/** How long one fall and rise of its opacity takes, ms. */
export const PLACEHOLDER_PERIOD_MS = 2000;

/** The head's radius at most, as a share of the hitbox's width. */
export const PLACEHOLDER_HEAD_OF_WIDTH = 0.3;

/** The head's radius at most, as a share of the hitbox's height. */
export const PLACEHOLDER_HEAD_OF_HEIGHT = 0.17;

/** The gap between the head and the body, as a share of the head's radius. */
export const PLACEHOLDER_NECK_OF_HEAD = 0.25;

/** The body's corner radius at most, as a share of its width. */
export const PLACEHOLDER_CORNER_OF_WIDTH = 0.35;

/** A circle: its centre and radius. */
export interface PlaceholderCircle {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** A rectangle with round corners: its top-left corner, size and radius. */
export interface PlaceholderRoundRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/** The figure, in the actor's local coordinates (base pixels). */
export interface PlaceholderShape {
  /** At the top, in the middle, touching the hitbox's top. */
  readonly head: PlaceholderCircle;
  /** Under the head, the hitbox's whole width, down to its bottom. */
  readonly body: PlaceholderRoundRect;
}

/** The figure filling `hitbox`. */
export function placeholderShape(hitbox: LocalBox): PlaceholderShape {
  const { x, y, width, height } = hitbox;
  const radius = Math.min(
    width * PLACEHOLDER_HEAD_OF_WIDTH,
    height * PLACEHOLDER_HEAD_OF_HEIGHT,
  );
  const top = y + radius * (2 + PLACEHOLDER_NECK_OF_HEAD);
  const bodyHeight = y + height - top;
  return {
    head: { x: x + width / 2, y: y + radius, radius },
    body: {
      x,
      y: top,
      width,
      height: bodyHeight,
      radius: Math.min(width * PLACEHOLDER_CORNER_OF_WIDTH, bodyHeight / 2),
    },
  };
}

/**
 * Its opacity `timeMs` into the render loop's time: PLACEHOLDER_ALPHA_MAX
 * at 0 and every PLACEHOLDER_PERIOD_MS after, PLACEHOLDER_ALPHA_MIN half
 * way, smoothly between. A time that is not a number counts as 0.
 */
export function placeholderAlpha(timeMs: number): number {
  const time = Number.isFinite(timeMs) ? timeMs : 0;
  const wave =
    0.5 + 0.5 * Math.cos((2 * Math.PI * time) / PLACEHOLDER_PERIOD_MS);
  return (
    PLACEHOLDER_ALPHA_MIN +
    (PLACEHOLDER_ALPHA_MAX - PLACEHOLDER_ALPHA_MIN) * wave
  );
}
