import { z } from '../zod-setup';
import {
  FLOAT_TOLERANCE,
  fitsGrid,
  repeatedIndexes,
  ruleIssue,
} from './common';

/**
 * Fixed parameters: the ones every character has, applied by the stage and
 * never handed to the pack. Each one's value is "the user's override ??
 * the manifest's `defaults` (only `scale` and `wander`) ?? the stage
 * default below" (computed by main/settings in 3.3 and 3.6, not here).
 */

/** `scale`'s range and step: 0.5 to 2.0 in steps of 0.1. */
export const SCALE_GRID = Object.freeze({ min: 0.5, max: 2, step: 0.1 });

/**
 * Whether `value` is a `scale`: on SCALE_GRID to within FLOAT_TOLERANCE.
 * 1.0 is the pack's own size; hitboxes scale with it.
 */
export function isValidScale(value: number): boolean {
  return fitsGrid(value, SCALE_GRID, FLOAT_TOLERANCE);
}

export const scaleSchema = z
  .number()
  .refine(
    isValidScale,
    ruleIssue('scale-off-grid', 'scale is 0.5 to 2.0 in steps of 0.1'),
  );

/**
 * A cell of the 3 × 3 grid over the chosen screen, numbered row by row from
 * the top left: 0 to 2 is the top row, 6 to 8 the bottom row.
 */
export const wanderAreaSchema = z.int().min(0).max(8);

/**
 * The cells a character prefers to wander in, 1 to 9 of them, each once. A
 * soft preference, not a boundary (Epic 4).
 */
export const wanderAreasSchema = z
  .array(wanderAreaSchema)
  .min(1)
  .max(9)
  .refine(
    (areas) => repeatedIndexes(areas).length === 0,
    ruleIssue('duplicate-wander-area', 'areas are unique'),
  );

/** How long a character stays before it moves on. */
export const WANDER_ACTIVITY_CODES = ['low', 'medium', 'high'] as const;

export const wanderActivitySchema = z.enum(WANDER_ACTIVITY_CODES);

export const WANDER_SPEED_CODES = ['slow', 'medium', 'fast'] as const;

export const wanderSpeedSchema = z.enum(WANDER_SPEED_CODES);

/** The wander preference (Epic 4 acts on it). */
export const wanderSchema = z.strictObject({
  enabled: z.boolean(),
  areas: wanderAreasSchema,
  activity: wanderActivitySchema,
  speed: wanderSpeedSchema,
});

export type Wander = z.infer<typeof wanderSchema>;

/** Every fixed parameter of one character. */
export const fixedParamsSchema = z.strictObject({
  scale: scaleSchema,
  /** Whether the character joins the pool. */
  inPool: z.boolean(),
  /** Whether its name tag and state badge are drawn. */
  badges: z.boolean(),
  wander: wanderSchema,
});

export type FixedParams = z.infer<typeof fixedParamsSchema>;

/** FixedParams with every level, the areas list included, read-only. */
export type FrozenFixedParams = Readonly<Omit<FixedParams, 'wander'>> & {
  readonly wander: Readonly<Omit<Wander, 'areas'>> & {
    readonly areas: readonly number[];
  };
};

/** The stage's defaults: the last step of each fixed parameter's value. */
export const FIXED_PARAM_DEFAULTS: FrozenFixedParams = Object.freeze({
  scale: 1,
  inPool: true,
  badges: true,
  wander: Object.freeze({
    enabled: true,
    areas: Object.freeze([6, 7, 8]),
    activity: 'medium',
    speed: 'medium',
  }),
});

/**
 * A manifest character's `defaults`: only `scale` and `wander`, and `wander`
 * may give only some of its fields.
 */
export const characterDefaultsSchema = z.strictObject({
  scale: scaleSchema.exactOptional(),
  wander: z
    .strictObject({
      enabled: z.boolean().exactOptional(),
      areas: wanderAreasSchema.exactOptional(),
      activity: wanderActivitySchema.exactOptional(),
      speed: wanderSpeedSchema.exactOptional(),
    })
    .exactOptional(),
});

export type CharacterDefaults = z.infer<typeof characterDefaultsSchema>;

/**
 * The character height, in base pixels, packs are drawn for. The panel
 * hints (never blocks, never rescales) when a character's declared height
 * is off by more than CHARACTER_HEIGHT_HINT_TOLERANCE of it: heights from
 * 82.5 to 137.5, both included, get no hint; anything below 82.5 or above
 * 137.5 does.
 */
export const RECOMMENDED_CHARACTER_HEIGHT = 110;

export const CHARACTER_HEIGHT_HINT_TOLERANCE = 0.25;
