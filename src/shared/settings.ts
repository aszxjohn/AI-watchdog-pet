import {
  FIXED_OVERRIDES_MAX_ENTRIES,
  PACK_ENABLED_MAX_ENTRIES,
} from './constants';
import { FIXED_PARAM_DEFAULTS, packIdSchema } from './pack-api';
import { characterKey, characterKeySchema } from './packs';
import { z } from './zod-setup';

/**
 * The settings contract (AD-23): settings.json on disk, `settings:get`,
 * `settings:patch` and the settings section of StageView all use the schemas
 * here and nowhere else. User-adjustable defaults live only here (AD-26).
 *
 * Two settings are kept by key (Story 3.3): `packEnabled` (上場, per pack)
 * and `fixedOverrides` (the fixed parameters the user changed, per
 * character). Each holds only the values that differ from the stage
 * default, is changed one key at a time (`setPackEnabled`, `setFixed`),
 * never by a whole-value `set`, and is read only through isPackEnabled and
 * isInPool below.
 */

/**
 * Layout version of settings.json. A file with an older version goes through
 * main/settings/migrations; a newer or invalid one counts as broken.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Most field operations a single `settings:patch` may carry. */
export const SETTINGS_PATCH_MAX_OPS = 64;

/**
 * Revision of the settings values. Each run starts at 0 and adds 1 per patch
 * that changes something; it is never saved.
 */
export const settingsRevSchema = z.int().nonnegative();

/** The value a pack's 上場 takes when settings.json has none: on. */
export const PACK_ENABLED_DEFAULT = true;

/**
 * A record keyed by `key`, at most `max` entries. An own `__proto__` key is
 * refused too: zod drops it from a record's output without an issue, so a
 * file with one would pass and lose that entry on the way.
 */
function keyedRecord<K extends z.ZodType<string>, V extends z.ZodType>(
  key: K,
  value: V,
  max: number,
) {
  return z
    .unknown()
    .refine(
      (record) =>
        typeof record !== 'object' ||
        record === null ||
        !Object.hasOwn(record, '__proto__'),
      { message: '__proto__ is not a key' },
    )
    .pipe(z.record(key, value))
    .refine((record) => Object.keys(record).length <= max, {
      message: `at most ${max} entries`,
    });
}

/**
 * The fixed parameters one character's entry in `fixedOverrides` may hold,
 * each only when it differs from FIXED_PARAM_DEFAULTS. Only `inPool` so far
 * (Story 3.3); Story 3.6 adds `scale` and the rest.
 *
 * "Differs from FIXED_PARAM_DEFAULTS" holds only for a parameter the
 * manifest cannot give a default (`inPool`, `badges`). For `scale` and
 * `wander`, which a manifest's `defaults` can set, Story 3.6 must compare
 * against the effective default (manifest `defaults` ?? stage default),
 * and compare objects (`wander`) by value, not with `===`.
 */
export const fixedOverrideSchema = z.strictObject({
  inPool: z.boolean().exactOptional(),
});

export type FixedOverride = z.infer<typeof fixedOverrideSchema>;

/**
 * One schema per setting. Adding a setting means one entry here and one in
 * SETTINGS_DEFAULTS; the file, patch and StageView schemas follow from it.
 */
export const settingsFieldSchemas = {
  /**
   * Electron `Display.id` of the screen the canvas sits on; null means the
   * primary display. Story 1.6 applies it.
   */
  canvasDisplayId: z.int().nonnegative().nullable(),
  /**
   * The detection timings (AD-21, AD-22), whole milliseconds. How long a
   * session stays `done` after `turn.end`.
   */
  doneMs: z.int().min(1000).max(60_000),
  /** How long after its last event a session counts as `waiting`, not `idle`. */
  idleMs: z.int().min(60_000).max(3_600_000),
  /** How long `error` holds unless a turn or a tool starts first. */
  errorHoldMs: z.int().min(1000).max(600_000),
  /**
   * A tool call still running this long after it started, on a source whose
   * records cannot show the request, is guessed to be waiting for approval
   * (a question, for its question tools; main/detection/inference).
   */
  approvalInferMs: z.int().min(1000).max(600_000),
  /**
   * A session with no event for this long ends (main/detection/sessions).
   * The minimum, 61 minutes, is above the most `idleMs` can be (60
   * minutes), so a session always shows `idle` before it expires; a file
   * with less is a bad field and takes the default.
   */
  sessionExpireMs: z.int().min(3_660_000).max(86_400_000),
  /**
   * At start, adapters replay only records modified within this long. It
   * should be at least `sessionExpireMs` (the defaults are equal): when it
   * is smaller, a session that had not expired at restart is not found
   * again. Nothing checks it.
   */
  discoveryWindowMs: z.int().min(600_000).max(86_400_000),
  /**
   * How long after detection starts every source counts as synced, whether
   * or not it has sent `sync.ready`.
   */
  syncTimeoutMs: z.int().min(1000).max(60_000),
  /**
   * 上場 per pack id, only where it differs from PACK_ENABLED_DEFAULT
   * (Story 3.3), at most PACK_ENABLED_MAX_ENTRIES. A pack that is not
   * installed (or no longer is) keeps its entry. Read it with
   * isPackEnabled.
   */
  packEnabled: keyedRecord(packIdSchema, z.boolean(), PACK_ENABLED_MAX_ENTRIES),
  /**
   * The fixed parameters the user changed, per character key
   * (`<packId>/<characterId>`), each only where it differs from
   * FIXED_PARAM_DEFAULTS (Story 3.3), at most FIXED_OVERRIDES_MAX_ENTRIES
   * characters. A character that is not installed (or is gone from the
   * pack's new version) keeps its entry. Read it with isInPool.
   */
  fixedOverrides: keyedRecord(
    characterKeySchema,
    fixedOverrideSchema,
    FIXED_OVERRIDES_MAX_ENTRIES,
  ),
} as const;

export type SettingsField = keyof typeof settingsFieldSchemas;

/** Every setting's field name, in declaration order. */
export const SETTINGS_FIELDS: readonly SettingsField[] = Object.freeze(
  Object.keys(settingsFieldSchemas) as SettingsField[],
);

/**
 * The settings changed one key at a time (`setPackEnabled`, `setFixed`):
 * a `set` op cannot overwrite them whole.
 */
export const SETTINGS_KEYED_FIELDS = Object.freeze([
  'packEnabled',
  'fixedOverrides',
] as const);

export type SettingsKeyedField = (typeof SETTINGS_KEYED_FIELDS)[number];

/** The settings a `set` op changes: every field but the keyed ones. */
export type SettingsSetField = Exclude<SettingsField, SettingsKeyedField>;

/** SettingsSetField's fields, in declaration order. */
export const SETTINGS_SET_FIELDS: readonly SettingsSetField[] = Object.freeze(
  SETTINGS_FIELDS.filter(
    (field): field is SettingsSetField =>
      !(SETTINGS_KEYED_FIELDS as readonly string[]).includes(field),
  ),
);

/** A complete set of settings values: every field, nothing else. */
export const settingsValuesSchema = z.strictObject(settingsFieldSchemas);

export type SettingsValues = z.infer<typeof settingsValuesSchema>;

/** The value each field takes when it is missing or invalid. */
export const SETTINGS_DEFAULTS: Readonly<SettingsValues> = Object.freeze({
  canvasDisplayId: null,
  doneMs: 5000,
  idleMs: 300_000,
  errorHoldMs: 30_000,
  approvalInferMs: 10_000,
  sessionExpireMs: 7_200_000,
  discoveryWindowMs: 7_200_000,
  syncTimeoutMs: 10_000,
  packEnabled: Object.freeze({}),
  fixedOverrides: Object.freeze({}),
});

/**
 * The detection timings, as main/settings holds them. Any SettingsValues is
 * one, so main/detection can be handed the current settings values as they
 * are.
 */
export type DetectionTimings = Pick<
  SettingsValues,
  | 'doneMs'
  | 'idleMs'
  | 'errorHoldMs'
  | 'approvalInferMs'
  | 'sessionExpireMs'
  | 'discoveryWindowMs'
  | 'syncTimeoutMs'
>;

/** settings.json as main/settings writes it. */
export const settingsFileSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  ...settingsFieldSchemas,
});

export type SettingsFile = z.infer<typeof settingsFileSchema>;

/** The values with their rev: what `settings:get` answers. */
export const settingsStateSchema = z.strictObject({
  rev: settingsRevSchema,
  values: settingsValuesSchema,
});

export type SettingsState = z.infer<typeof settingsStateSchema>;

/**
 * Whether pack `packId` is 上場: settings.json's value ?? PACK_ENABLED_DEFAULT.
 * The manifest has no say. The one place this is worked out (the 角色包
 * page and Story 3.4's main/pool both call it).
 */
export function isPackEnabled(
  values: Pick<SettingsValues, 'packEnabled'>,
  packId: string,
): boolean {
  return Object.hasOwn(values.packEnabled, packId)
    ? (values.packEnabled[packId] ?? PACK_ENABLED_DEFAULT)
    : PACK_ENABLED_DEFAULT;
}

/**
 * Whether character `characterId` of pack `packId` joins the pool (加入池子,
 * the fixed parameter `inPool`): settings.json's value ??
 * FIXED_PARAM_DEFAULTS.inPool. The manifest has no say (its `defaults`
 * give only `scale` and `wander`). The one place this is worked out (the
 * 角色包 page and Story 3.4's main/pool both call it).
 */
export function isInPool(
  values: Pick<SettingsValues, 'fixedOverrides'>,
  packId: string,
  characterId: string,
): boolean {
  const key = characterKey(packId, characterId);
  const override = Object.hasOwn(values.fixedOverrides, key)
    ? values.fixedOverrides[key]
    : undefined;
  return override?.inPool ?? FIXED_PARAM_DEFAULTS.inPool;
}

function setOpSchema<F extends SettingsSetField>(field: F) {
  return z.strictObject({
    op: z.literal('set'),
    field: z.literal(field),
    value: settingsFieldSchemas[field],
  });
}

type SetOpSchema = {
  [F in SettingsSetField]: ReturnType<typeof setOpSchema<F>>;
}[SettingsSetField];

/**
 * `{ op: 'set', field, value }`, one variant per SettingsSetField, so
 * `value` is checked against that field's own schema. The keyed settings
 * have no variant: they are never overwritten whole.
 */
export const settingsSetOpSchema = z.discriminatedUnion(
  'field',
  SETTINGS_SET_FIELDS.map((field) => setOpSchema(field)) as unknown as [
    SetOpSchema,
    ...SetOpSchema[],
  ],
);

/**
 * `{ op: 'setPackEnabled', packId, value }`: 上場 of that one pack. A value
 * equal to PACK_ENABLED_DEFAULT removes the pack's entry from
 * `packEnabled`.
 */
export const setPackEnabledOpSchema = z.strictObject({
  op: z.literal('setPackEnabled'),
  packId: packIdSchema,
  value: z.boolean(),
});

/**
 * `{ op: 'setFixed', characterKey, param, value }`: one fixed parameter of
 * that one character. Only `inPool` so far. A value equal to
 * FIXED_PARAM_DEFAULTS removes the parameter from the character's entry in
 * `fixedOverrides`, and an entry left empty is removed.
 */
export const setFixedOpSchema = z.strictObject({
  op: z.literal('setFixed'),
  characterKey: characterKeySchema,
  param: z.literal('inPool'),
  value: z.boolean(),
});

/** One operation of a patch, told apart by `op`. */
export const settingsOpSchema = z.discriminatedUnion('op', [
  settingsSetOpSchema,
  setPackEnabledOpSchema,
  setFixedOpSchema,
]);

export type SettingsOp = z.infer<typeof settingsOpSchema>;

/**
 * The only way a renderer changes settings. Main applies `ops` in order to
 * the current values (a later op on the same field, or on the same key of a
 * keyed setting, wins); `baseRev` is the rev the renderer last saw and only
 * decides whether the reply says `merged`, so an op on one key never undoes
 * a newer change of another. There is no whole-file overwrite.
 */
export const settingsPatchSchema = z.strictObject({
  baseRev: settingsRevSchema,
  ops: z.array(settingsOpSchema).min(1).max(SETTINGS_PATCH_MAX_OPS),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * Reply to `settings:patch`: the rev after the patch; whether `baseRev` was
 * not the current rev, so the ops were merged into newer values; and
 * whether settings.json is being kept: false when this run cannot write it
 * or its last write failed and none has succeeded since. The values apply
 * either way; with `saved` false they are lost on restart. The file is
 * written after a debounce, so a write that fails after the reply is only
 * logged.
 */
export const settingsPatchResultSchema = z.strictObject({
  rev: settingsRevSchema,
  merged: z.boolean(),
  saved: z.boolean(),
});

export type SettingsPatchResult = z.infer<typeof settingsPatchResultSchema>;
