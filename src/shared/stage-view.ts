import { settingsStateSchema } from './settings';
import { z } from './zod-setup';

/**
 * StageView (AD-20): the single state main publishes to renderers.
 * main/stage-view composes it; renderers subscribe and receive a snapshot,
 * then deltas. Epic 1 has one section, `settings`.
 */

/**
 * Revision of the whole StageView. Each run starts at 0 and adds 1 per delta;
 * it is separate from the settings rev.
 */
export const stageViewRevSchema = z.int().nonnegative();

export const stageViewSchema = z.strictObject({
  settings: settingsStateSchema,
});

export type StageView = z.infer<typeof stageViewSchema>;

export type StageViewSectionName = keyof StageView;

/** The answer to `stage-view:subscribe`: the whole view at `rev`. */
export const stageViewSnapshotSchema = z.strictObject({
  rev: stageViewRevSchema,
  view: stageViewSchema,
});

export type StageViewSnapshot = z.infer<typeof stageViewSnapshotSchema>;

/**
 * The sections a delta replaces, whole. Lists every section of
 * stageViewSchema; a key that is present must hold a section (`undefined`
 * is rejected), and at least one key must be present.
 */
export const stageViewSectionsSchema = z
  .strictObject({
    settings: settingsStateSchema.exactOptional(),
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
