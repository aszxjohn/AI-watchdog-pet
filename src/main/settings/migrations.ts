/**
 * Forward-only migrations of settings.json (AD-23). `SETTINGS_MIGRATIONS[n]`
 * turns a version-n file into a version n+1 file; main/settings runs the
 * steps in order up to SETTINGS_SCHEMA_VERSION. A file that is newer than
 * this build, or a step that is missing, throws or returns a non-object,
 * makes the file count as broken. The runner is main/persist's, shared with
 * main/pool.
 */
import {
  isPlainObject,
  migrateFile,
  type FileMigration,
  type FileMigrations,
  type MigrationOutcome,
} from '../persist/migrate';

export { isPlainObject, type MigrationOutcome };

/**
 * One step. It receives a copy of the file's object (with its old
 * `schemaVersion`) and returns the next version's object; the runner sets
 * `schemaVersion` itself.
 */
export type SettingsMigration = FileMigration;

/** Steps keyed by the version they upgrade from. */
export type SettingsMigrations = FileMigrations;

/** Empty while SETTINGS_SCHEMA_VERSION is 1. */
export const SETTINGS_MIGRATIONS: SettingsMigrations = Object.freeze({});

/**
 * Upgrades `data` from `fromVersion` to `toVersion`. The reason on failure
 * names versions only, never file contents.
 */
export const migrateSettings = migrateFile;
