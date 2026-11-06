/**
 * The displays and where the canvas goes (AD-14), as pure functions over
 * what Electron's `screen` reports:
 *
 * - toStageDisplays: the StageView `displays` section;
 * - resolveCanvasPlacement: the StageView `canvas` section. The display the
 *   `canvasDisplayId` setting names, when it is connected; otherwise the
 *   primary display, marked `fallback` when a display was named but is not
 *   connected. The setting itself never changes here, so the canvas moves
 *   back as soon as that display is connected again.
 */
import {
  DISPLAY_LABEL_MAX_LENGTH,
  displayIdSchema,
  type DisplayBounds,
  type StageCanvas,
  type StageDisplay,
} from '../../shared/stage-view';

/** The parts of an Electron `Display` used here. */
export interface ScreenDisplay {
  readonly id: number;
  readonly label: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly scaleFactor: number;
}

/**
 * Every display Electron reports, in its order, as the StageView
 * `displays` section. `primaryId` is `screen.getPrimaryDisplay().id`.
 *
 * A display whose id the shared schema cannot carry (not a non-negative
 * safe integer; possible for EDID-based ids on Linux) is left out: it could
 * not be chosen in settings either, and one bad entry would make the whole
 * StageView invalid. Bounds are rounded, a label is cut to
 * DISPLAY_LABEL_MAX_LENGTH, and a scale factor that is not a positive
 * number counts as 1.
 */
export function toStageDisplays(
  displays: readonly ScreenDisplay[],
  primaryId: number,
): StageDisplay[] {
  return displays
    .filter((display) => displayIdSchema.safeParse(display.id).success)
    .map((display) => ({
      id: display.id,
      label:
        typeof display.label === 'string'
          ? display.label.slice(0, DISPLAY_LABEL_MAX_LENGTH)
          : '',
      bounds: roundBounds(display.bounds),
      scaleFactor:
        Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
          ? display.scaleFactor
          : 1,
      primary: display.id === primaryId,
    }));
}

function roundBounds(bounds: ScreenDisplay['bounds']): DisplayBounds {
  // `|| 0` turns -0 into 0.
  return {
    x: Math.round(bounds.x) || 0,
    y: Math.round(bounds.y) || 0,
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

/**
 * Where the canvas goes, given the `canvasDisplayId` setting (null: the
 * primary display) and the connected displays:
 *
 * - the named display, when it is connected;
 * - otherwise the primary display (the first display if none is marked
 *   primary), with `fallback: true` when a display was named;
 * - null when there is no display at all.
 */
export function resolveCanvasPlacement(
  canvasDisplayId: number | null,
  displays: readonly StageDisplay[],
): StageCanvas {
  const chosen =
    canvasDisplayId === null
      ? undefined
      : displays.find((display) => display.id === canvasDisplayId);
  const target =
    chosen ?? displays.find((display) => display.primary) ?? displays[0];
  if (target === undefined) {
    return null;
  }
  return {
    displayId: target.id,
    bounds: { ...target.bounds },
    scaleFactor: target.scaleFactor,
    fallback: canvasDisplayId !== null && chosen === undefined,
  };
}

/** `display 1, 1512x982 at 0,0, scale 2` for the run log. */
export function describePlacement(placement: NonNullable<StageCanvas>): string {
  const { displayId, bounds, scaleFactor } = placement;
  return `display ${displayId}, ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}, scale ${scaleFactor}`;
}
