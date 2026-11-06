/**
 * Forward-only migrations of settings.json (AD-23). `SETTINGS_MIGRATIONS[n]`
 * turns a version-n file into a version n+1 file; main/settings runs the
 * steps in order up to SETTINGS_SCHEMA_VERSION. A file that is newer than
 * this build, or a step that is missing, throws or returns a non-object,
 * makes the file count as broken.
 */
import { errorCode } from '../log/run-log';

/**
 * One step. It receives a copy of the file's object (with its old
 * `schemaVersion`) and returns the next version's object; the runner sets
 * `schemaVersion` itself.
 */
export type SettingsMigration = (
  data: Record<string, unknown>,
) => Record<string, unknown>;

/** Steps keyed by the version they upgrade from. */
export type SettingsMigrations = Readonly<Record<number, SettingsMigration>>;

/** Empty while SETTINGS_SCHEMA_VERSION is 1. */
export const SETTINGS_MIGRATIONS: SettingsMigrations = Object.freeze({});

export type MigrationOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Upgrades `data` from `fromVersion` to `toVersion`. The reason on failure
 * names versions only, never file contents.
 */
export function migrateSettings(
  data: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  migrations: SettingsMigrations,
): MigrationOutcome {
  if (fromVersion > toVersion) {
    return {
      ok: false,
      reason: `schemaVersion ${fromVersion} is newer than this build supports (${toVersion})`,
    };
  }
  let current = data;
  for (let version = fromVersion; version < toVersion; version += 1) {
    const step = Object.hasOwn(migrations, version)
      ? migrations[version]
      : undefined;
    if (typeof step !== 'function') {
      return {
        ok: false,
        reason: `no migration from schemaVersion ${version}`,
      };
    }
    let next: unknown;
    try {
      next = step(structuredClone(current));
    } catch (error) {
      return {
        ok: false,
        reason: `migration from schemaVersion ${version} failed (${errorCode(error)})`,
      };
    }
    if (!isPlainObject(next)) {
      return {
        ok: false,
        reason: `migration from schemaVersion ${version} did not return an object`,
      };
    }
    current = { ...next, schemaVersion: version + 1 };
  }
  return { ok: true, data: current };
}
