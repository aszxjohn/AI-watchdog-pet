import { settingsStateSchema } from './settings';
import { z } from './zod-setup';

/**
 * StageView (AD-20): the single state main publishes to renderers.
 * main/stage-view composes it; renderers subscribe and receive a snapshot,
 * then deltas. Sections and their owners:
 *
 * - `settings`: main/settings;
 * - `displays`, `canvas`, `power`: main/windows (Story 1.6).
 */

/**
 * Revision of the whole StageView. Each run starts at 0 and adds 1 per delta;
 * it is separate from the settings rev.
 */
export const stageViewRevSchema = z.int().nonnegative();

/**
 * Electron `Display.id`. Same rule as the `canvasDisplayId` setting, so any
 * listed display can be chosen there.
 */
export const displayIdSchema = z.int().nonnegative();

/** A rectangle in DIP (Electron `Rectangle`); x and y may be negative. */
export const displayBoundsSchema = z.strictObject({
  x: z.int(),
  y: z.int(),
  width: z.int().positive(),
  height: z.int().positive(),
});

export type DisplayBounds = z.infer<typeof displayBoundsSchema>;

/** Longest display label kept; main cuts longer platform names. */
export const DISPLAY_LABEL_MAX_LENGTH = 200;

/** One connected display. */
export const stageDisplaySchema = z.strictObject({
  id: displayIdSchema,
  /** The platform's name for it; may be empty (some Linux setups). */
  label: z.string().max(DISPLAY_LABEL_MAX_LENGTH),
  bounds: displayBoundsSchema,
  scaleFactor: z.number().positive(),
  /** Whether it is the system's primary display right now. */
  primary: z.boolean(),
});

export type StageDisplay = z.infer<typeof stageDisplaySchema>;

/** `displays`: every connected display, ids unique, at most one primary. */
export const stageDisplaysSchema = z
  .array(stageDisplaySchema)
  .refine(
    (displays) => new Set(displays.map((d) => d.id)).size === displays.length,
    { message: 'display ids are unique' },
  )
  .refine((displays) => displays.filter((d) => d.primary).length <= 1, {
    message: 'at most one display is primary',
  });

/**
 * `canvas`: where the canvas actually is. The world is `bounds.width` x
 * `bounds.height` with its origin (0, 0) at the top left; `bounds.x` and
 * `bounds.y` only place the window. `fallback` is true when the chosen
 * display is not connected and the canvas is on the primary display for now.
 * Null until main has placed the canvas.
 */
export const stageCanvasSchema = z
  .strictObject({
    displayId: displayIdSchema,
    bounds: displayBoundsSchema,
    scaleFactor: z.number().positive(),
    fallback: z.boolean(),
  })
  .nullable();

export type StageCanvas = z.infer<typeof stageCanvasSchema>;

/** `power`: whether the system is asleep and whether the screen is locked. */
export const stagePowerSchema = z.strictObject({
  suspended: z.boolean(),
  locked: z.boolean(),
});

export type StagePower = z.infer<typeof stagePowerSchema>;

export const stageViewSchema = z.strictObject({
  settings: settingsStateSchema,
  displays: stageDisplaysSchema,
  canvas: stageCanvasSchema,
  power: stagePowerSchema,
});

export type StageView = z.infer<typeof stageViewSchema>;

export type StageViewSectionName = keyof StageView;

/** The sections main/windows owns. */
export type StageViewWindowsSections = Pick<
  StageView,
  'displays' | 'canvas' | 'power'
>;

/** The answer to `stage-view:subscribe`: the whole view at `rev`. */
export const stageViewSnapshotSchema = z.strictObject({
  rev: stageViewRevSchema,
  view: stageViewSchema,
});

export type StageViewSnapshot = z.infer<typeof stageViewSnapshotSchema>;

/**
 * The sections a delta replaces, whole. Lists every section of
 * stageViewSchema; a key that is present must hold a section (`undefined`
 * is rejected; `canvas` may be null), and at least one key must be present.
 */
export const stageViewSectionsSchema = z
  .strictObject({
    settings: settingsStateSchema.exactOptional(),
    displays: stageDisplaysSchema.exactOptional(),
    canvas: stageCanvasSchema.exactOptional(),
    power: stagePowerSchema.exactOptional(),
  })
  .refine((sections) => Object.keys(sections).length > 0, {
    message: 'a delta carries at least one section',
  });

export type StageViewSections = z.infer<typeof stageViewSectionsSchema>;

/**
 * Pushed on `stage-view:delta`. `rev` is always the previous rev + 1; a
 * renderer that sees any other rev re-fetches the snapshot.
 */
export const stageViewDeltaSchema = z.strictObject({
  rev: stageViewRevSchema.min(1),
  sections: stageViewSectionsSchema,
});

export type StageViewDelta = z.infer<typeof stageViewDeltaSchema>;

/** The view after a delta: each section in `sections` replaces the old one. */
export function applyStageViewDelta(
  view: StageView,
  sections: StageViewSections,
): StageView {
  return { ...view, ...sections };
}
