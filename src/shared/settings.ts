import { z } from './zod-setup';

/**
 * The settings contract (AD-23): settings.json on disk, `settings:get`,
 * `settings:patch` and the settings section of StageView all use the schemas
 * here and nowhere else. User-adjustable defaults live only here (AD-26).
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
} as const;

export type SettingsField = keyof typeof settingsFieldSchemas;

/** Every setting's field name, in declaration order. */
export const SETTINGS_FIELDS: readonly SettingsField[] = Object.freeze(
  Object.keys(settingsFieldSchemas) as SettingsField[],
);

/** A complete set of settings values: every field, nothing else. */
export const settingsValuesSchema = z.strictObject(settingsFieldSchemas);

export type SettingsValues = z.infer<typeof settingsValuesSchema>;

/** The value each field takes when it is missing or invalid. */
export const SETTINGS_DEFAULTS: Readonly<SettingsValues> = Object.freeze({
  canvasDisplayId: null,
});

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

function setOpSchema<F extends SettingsField>(field: F) {
  return z.strictObject({
    op: z.literal('set'),
    field: z.literal(field),
    value: settingsFieldSchemas[field],
  });
}

type SetOpSchema = {
  [F in SettingsField]: ReturnType<typeof setOpSchema<F>>;
}[SettingsField];

/**
 * `{ op: 'set', field, value }`, one variant per field, so `value` is checked
 * against that field's own schema.
 */
export const settingsOpSchema = z.discriminatedUnion(
  'field',
  SETTINGS_FIELDS.map((field) => setOpSchema(field)) as unknown as [
    SetOpSchema,
    ...SetOpSchema[],
  ],
);

export type SettingsOp = z.infer<typeof settingsOpSchema>;

/**
 * The only way a renderer changes settings. Main applies `ops` in order to
 * the current values (a later op on the same field wins); `baseRev` is the
 * rev the renderer last saw and only decides whether the reply says
 * `merged`. There is no whole-file overwrite.
 */
export const settingsPatchSchema = z.strictObject({
  baseRev: settingsRevSchema,
  ops: z.array(settingsOpSchema).min(1).max(SETTINGS_PATCH_MAX_OPS),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * Reply to `settings:patch`: the rev after the patch, and whether `baseRev`
 * was not the current rev, so the ops were merged into newer values.
 */
export const settingsPatchResultSchema = z.strictObject({
  rev: settingsRevSchema,
  merged: z.boolean(),
});

export type SettingsPatchResult = z.infer<typeof settingsPatchResultSchema>;
