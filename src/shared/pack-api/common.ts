import { z } from '../zod-setup';

/**
 * Building blocks the parts of the character pack API share. Like the rest
 * of src/shared/pack-api, this file depends on zod-setup and states only
 * (dependency-cruiser holds it).
 */

/**
 * A pack id, character id, parameter key, asset key, choice value or
 * particle preset: lowercase letters, digits and `-`, 2 to 64 characters,
 * not starting with `-`. It can never start with `_`, so `pack://_stage/`
 * stays the stage's own host.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const idSchema = z.string().regex(ID_PATTERN);

export type Id = z.infer<typeof idSchema>;

/** Longest pack name, character name or parameter label, in UTF-16 units. */
export const LABEL_MAX_LENGTH = 64;

/**
 * The stable code of each rule a pack API schema checks beyond zod's own
 * checks. Its issues have zod code `custom` and carry the rule as
 * `params.rule`, so the import (3.2) can show its own text for each one.
 */
export const PACK_API_ISSUE_RULES = [
  'blank-label',
  'reserved-key',
  'pack-id-all-digits',
  'pack-id-hex-prefix',
  'pack-id-device-name',
  'invalid-pack-path',
  'entry-not-js',
  'scale-off-grid',
  'duplicate-wander-area',
  'param-min-above-max',
  'int-max-off-grid',
  'invalid-param-default',
  'duplicate-choice-value',
  'choice-default-not-option',
  'duplicate-asset-option',
  'asset-default-not-option',
  'duplicate-character-id',
  'duplicate-param-key',
  'missing-asset-option',
  'missing-asset-default',
  'duplicate-state',
  'fallback-key-in-states',
  'fallback-value-not-in-states',
  'hitbox-outside-bounds',
  'missing-projectile-asset',
  'duplicate-actor-id',
  'duplicate-emitter-id',
  'bitmap-image-not-object',
] as const;

export type PackApiIssueRule = (typeof PACK_API_ISSUE_RULES)[number];

/** `.refine()` options for an issue of `rule`. */
export function ruleIssue(
  rule: PackApiIssueRule,
  message: string,
): { message: string; params: { rule: PackApiIssueRule } } {
  return { message, params: { rule } };
}

/** Adds an issue of `rule` at `path` from a `.superRefine()`. */
export function addRuleIssue(
  ctx: z.RefinementCtx,
  rule: PackApiIssueRule,
  message: string,
  path: PropertyKey[],
): void {
  ctx.addIssue({ code: 'custom', message, path, params: { rule } });
}

/**
 * A name or label shown to the user: 1 to LABEL_MAX_LENGTH characters, at
 * least one of them not white space.
 */
export const labelSchema = z
  .string()
  .min(1)
  .max(LABEL_MAX_LENGTH)
  .refine(
    (label) => /\S/.test(label),
    ruleIssue('blank-label', 'a label is not only white space'),
  );

/**
 * `record` that also rejects an own `__proto__` key. zod drops that key from
 * a record's output without an issue, so a value would pass and lose an
 * entry on the way. Every record in the pack API goes through this.
 */
export function withoutProtoKey<T extends z.ZodType>(record: T) {
  return z
    .unknown()
    .refine(
      (value) =>
        typeof value !== 'object' ||
        value === null ||
        !Object.hasOwn(value, '__proto__'),
      ruleIssue('reserved-key', '__proto__ is not a key'),
    )
    .pipe(record);
}

/**
 * How far a non-integer value may sit off its range or step and still count
 * as on it (`scale`, `number` parameters), relative to the size of the
 * numbers compared (see fitsGrid): 0.1 steps added in floating point land a
 * few ULPs away from the exact decimal.
 */
export const FLOAT_TOLERANCE = 1e-9;

/** A range and an optional step, as a parameter or `scale` declares them. */
export interface NumberGrid {
  readonly min: number;
  readonly max: number;
  /** Values sit on min + n × step; no step means any value in range. */
  readonly step?: number;
}

/**
 * Whether `value` is within the grid's range and on one of its steps, each
 * to within `tolerance` × max(1, |min|, |value|): a ULP grows with the
 * number, so a fixed margin would miss steps far from 0. Pass 0 for
 * integers, which are exact.
 */
export function fitsGrid(
  value: number,
  grid: NumberGrid,
  tolerance: number,
): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  const margin = tolerance * Math.max(1, Math.abs(grid.min), Math.abs(value));
  if (value < grid.min - margin || value > grid.max + margin) {
    return false;
  }
  if (grid.step === undefined) {
    return true;
  }
  const steps = Math.round((value - grid.min) / grid.step);
  return Math.abs(grid.min + steps * grid.step - value) <= margin;
}

/** The indexes of items equal to an earlier item, in order. */
export function repeatedIndexes(items: readonly unknown[]): number[] {
  const seen = new Set<unknown>();
  const repeated: number[] = [];
  items.forEach((item, i) => {
    if (seen.has(item)) {
      repeated.push(i);
    } else {
      seen.add(item);
    }
  });
  return repeated;
}
