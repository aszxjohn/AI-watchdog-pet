import {
  type CharacterDefaults,
  FIXED_PARAM_DEFAULTS,
  type FrozenFixedParams,
  isValidParamValue,
  type ParamDecl,
  type ParamValues,
  scaleSchema,
  type Wander,
  wanderActivitySchema,
  wanderAreasSchema,
  wanderSpeedSchema,
} from './pack-api';
import type { z } from './zod-setup';

/**
 * The effective values of one character (AD-23, Story 3.6): its parameters
 * as the pack gets them, and its fixed parameters as the stage applies
 * them. main/settings is the one caller (main/settings/characters.ts); it
 * publishes what these answer as StageView's `characters` section, and
 * renderers only read that section.
 *
 * The two never mix: a parameter a pack declares stays in the parameters
 * even when its key is `scale` (or any other fixed parameter's name), and
 * no fixed parameter is ever put among the parameters.
 */

/**
 * A character's parameters: each declared key once, with the user's
 * override when it is still a valid value of that declaration as it is now
 * (isValidParamValue: the right type, in range and on a step, or one of the
 * options), else the declaration's `default`. An override for a key the
 * character does not declare is ignored. `overrides` is only read, never
 * changed, so an override that does not apply stays where it is kept. The
 * answer is frozen.
 */
export function effectiveParams(
  decls: readonly ParamDecl[],
  overrides: Readonly<Record<string, unknown>> = {},
): ParamValues {
  const values: ParamValues = {};
  for (const decl of decls) {
    const override = Object.hasOwn(overrides, decl.key)
      ? overrides[decl.key]
      : undefined;
    values[decl.key] = isValidParamValue(decl, override)
      ? override
      : decl.default;
  }
  return Object.freeze(values);
}

/**
 * The user's override of one character's fixed parameters, as main/settings
 * keeps it: any of them, `wander` field by field. main/settings'
 * `fixedOverrides` holds only `inPool` so far (Story 3.3); the rest come
 * with Epic 5's editing page. effectiveFixed checks each value it takes.
 */
export interface FixedParamsOverride {
  readonly scale?: number;
  readonly inPool?: boolean;
  readonly badges?: boolean;
  readonly wander?: Readonly<Partial<Wander>>;
}

/** Whether `value` is a boolean. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** A check that `value` passes `schema`. */
function passes<T>(schema: z.ZodType<T>): (value: unknown) => value is T {
  return (value: unknown): value is T => schema.safeParse(value).success;
}

const isScale = passes(scaleSchema);
const isAreas = passes(wanderAreasSchema);
const isActivity = passes(wanderActivitySchema);
const isSpeed = passes(wanderSpeedSchema);

/** The first of `candidates` that `valid` takes, else `fallback`. */
function firstValid<T>(
  valid: (value: unknown) => value is T,
  fallback: T,
  ...candidates: unknown[]
): T {
  for (const candidate of candidates) {
    if (valid(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

/**
 * A character's fixed parameters: each one is "the user's override ?? the
 * manifest's `defaults` (only `scale` and `wander`) ?? the stage default
 * (FIXED_PARAM_DEFAULTS)", where an override or a manifest default that is
 * not a valid value of that parameter (a `scale` off its grid, empty or
 * repeated `areas`, an unknown activity or speed, a non-boolean) is passed
 * over, as effectiveParams passes over an invalid parameter override.
 * `wander` is merged field by field, so a manifest (or an override) may give
 * only some of its fields. The answer is frozen, the `areas` list included,
 * and never shares a list with its inputs.
 */
export function effectiveFixed(
  characterDefaults: CharacterDefaults | undefined,
  override: FixedParamsOverride | undefined,
): FrozenFixedParams {
  const stage = FIXED_PARAM_DEFAULTS;
  const manifest = characterDefaults ?? {};
  const user = override ?? {};
  const areas: readonly number[] = firstValid(
    isAreas,
    stage.wander.areas,
    user.wander?.areas,
    manifest.wander?.areas,
  );
  const wander = {
    enabled: firstValid(
      isBoolean,
      stage.wander.enabled,
      user.wander?.enabled,
      manifest.wander?.enabled,
    ),
    areas: Object.freeze([...areas]),
    activity: firstValid(
      isActivity,
      stage.wander.activity,
      user.wander?.activity,
      manifest.wander?.activity,
    ),
    speed: firstValid(
      isSpeed,
      stage.wander.speed,
      user.wander?.speed,
      manifest.wander?.speed,
    ),
  };
  return Object.freeze({
    scale: firstValid(isScale, stage.scale, user.scale, manifest.scale),
    inPool: firstValid(isBoolean, stage.inPool, user.inPool),
    badges: firstValid(isBoolean, stage.badges, user.badges),
    wander: Object.freeze(wander),
  });
}
