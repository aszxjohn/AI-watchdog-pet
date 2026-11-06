/**
 * main/settings (FR23, AD-23): the only owner and writer of settings.json.
 *
 * Loading never loses the user's file:
 * - no file: defaults; nothing is created or backed up;
 * - unreadable file (e.g. EACCES): defaults, and this run never writes;
 * - broken file (not JSON, not an object, bad `schemaVersion`, newer than
 *   this build, or a migration that fails): renamed to
 *   `settings.json.broken-<YYYYMMDD-HHmmss>` and defaults are used; if the
 *   rename fails, this run never writes;
 * - some fields invalid or unknown: those fields take their defaults and
 *   unknown ones are dropped; the original is copied to a `.broken-` file and
 *   the corrected file is written back at once (so the next start does not
 *   back it up again); if the copy fails, this run never writes;
 * - missing fields simply take their defaults.
 *
 * Changes arrive only as patches. A patch shows up in get() and onChange
 * immediately; the file is written once SETTINGS_FLUSH_DEBOUNCE_MS after the
 * first change not yet on disk, always to a temp file renamed over
 * settings.json. flushSync() writes whatever is pending right now (app quit).
 * A failed write is logged, its temp file removed, and the values kept in
 * memory for the next flush.
 *
 * fs is synchronous on purpose: the file is tiny, the order of writes is
 * fixed, and the flush on quit is a plain call. Log lines name fields and
 * reasons only, never values or file contents.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FLUSH_DEBOUNCE_MS } from '../../shared/constants';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_FIELDS,
  SETTINGS_SCHEMA_VERSION,
  settingsFieldSchemas,
  settingsPatchSchema,
  settingsValuesSchema,
  type SettingsPatch,
  type SettingsPatchResult,
  type SettingsState,
  type SettingsValues,
} from '../../shared/settings';
import { localSecondStamp } from '../log/local-time';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import {
  SETTINGS_MIGRATIONS,
  isPlainObject,
  migrateSettings,
  type SettingsMigrations,
} from './migrations';

/** The parts of node:fs the store uses; tests inject failures. */
export interface SettingsFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(
    file: string,
    data: string,
    options: { encoding: 'utf8'; flush: true },
  ): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string, mode: number): void;
  unlinkSync(file: string): void;
  existsSync(file: string): boolean;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
}

export interface SettingsStoreOptions {
  /** Path of settings.json (`userData/settings.json`). */
  readonly file: string;
  readonly fs?: SettingsFs;
  readonly now?: () => number;
  readonly migrations?: SettingsMigrations;
  /** The version this build reads and writes; tests raise it to run migrations. */
  readonly schemaVersion?: number;
}

export type SettingsListener = (state: SettingsState) => void;

export interface SettingsStore {
  get(): SettingsState;
  /** Applies a patch. Throws only if `patch` fails the shared schema. */
  patch(patch: SettingsPatch): SettingsPatchResult;
  /** Called after every patch that changed a value. Returns an unsubscribe. */
  onChange(listener: SettingsListener): () => void;
  /** Writes pending changes now. Never throws. */
  flushSync(): void;
  /** False once the original file could not be kept safe this run. */
  readonly canWrite: boolean;
}

interface Loaded {
  readonly values: SettingsValues;
  readonly canWrite: boolean;
  /** The loaded values differ from the file and should be written back. */
  readonly needsWrite: boolean;
}

/** Up to how many `-N` suffixes are tried when backup names collide. */
const MAX_BACKUP_SUFFIX = 999;

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('settings', message, level);
}

/** Same value, as settings.json would store it. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function loadSettings({
  file,
  fs = nodeFs,
  now = Date.now,
  migrations = SETTINGS_MIGRATIONS,
  schemaVersion = SETTINGS_SCHEMA_VERSION,
}: SettingsStoreOptions): SettingsStore {
  const fileName = path.basename(file);

  /** A free `<file>.broken-<time>[-N]` path. Throws when there is none. */
  function backupPath(): string {
    const base = `${file}.broken-${localSecondStamp(new Date(now()))}`;
    if (!fs.existsSync(base)) {
      return base;
    }
    for (let n = 2; n <= MAX_BACKUP_SUFFIX; n += 1) {
      const candidate = `${base}-${n}`;
      if (!fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error('no free backup name');
  }

  /** Moves a broken file aside and starts from defaults. */
  function setAside(reason: string): Loaded {
    let target: string;
    try {
      target = backupPath();
      fs.renameSync(file, target);
    } catch (error) {
      log(
        `${fileName} is unusable (${reason}) and could not be renamed (${errorCode(error)}); using defaults and not writing ${fileName} this run`,
        'error',
      );
      return { values: SETTINGS_DEFAULTS, canWrite: false, needsWrite: false };
    }
    log(
      `${fileName} is unusable (${reason}); renamed it to ${path.basename(target)} and using defaults`,
      'error',
    );
    return { values: SETTINGS_DEFAULTS, canWrite: true, needsWrite: false };
  }

  function load(): Loaded {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        return { values: SETTINGS_DEFAULTS, canWrite: true, needsWrite: false };
      }
      log(
        `cannot read ${fileName} (${code}); using defaults and not writing ${fileName} this run`,
        'error',
      );
      return { values: SETTINGS_DEFAULTS, canWrite: false, needsWrite: false };
    }

    // An editor may have saved the file with a UTF-8 BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // The SyntaxError message quotes the file, so it is not logged.
      return setAside('not valid JSON');
    }
    if (!isPlainObject(data)) {
      return setAside('not a JSON object');
    }
    if (!Object.hasOwn(data, 'schemaVersion')) {
      return setAside('schemaVersion is missing');
    }
    const version = data.schemaVersion;
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      return setAside('schemaVersion is not a positive integer');
    }
    if (version !== schemaVersion) {
      const migrated = migrateSettings(
        data,
        version,
        schemaVersion,
        migrations,
      );
      if (!migrated.ok) {
        return setAside(migrated.reason);
      }
      log(
        `migrated ${fileName} from schemaVersion ${version} to ${schemaVersion}`,
      );
      data = migrated.data;
    }
    return readFields(data as Record<string, unknown>);
  }

  /** Field-by-field read of a file whose `schemaVersion` is current. */
  function readFields(data: Record<string, unknown>): Loaded {
    const read: Record<string, unknown> = {};
    const invalid: string[] = [];
    for (const field of SETTINGS_FIELDS) {
      if (!Object.hasOwn(data, field)) {
        read[field] = SETTINGS_DEFAULTS[field];
        continue;
      }
      const parsed = settingsFieldSchemas[field].safeParse(data[field]);
      if (parsed.success) {
        read[field] = parsed.data;
      } else {
        read[field] = SETTINGS_DEFAULTS[field];
        invalid.push(field);
      }
    }
    const known = new Set<string>(['schemaVersion', ...SETTINGS_FIELDS]);
    const unknown = Object.keys(data).filter((key) => !known.has(key));
    const values = Object.freeze(settingsValuesSchema.parse(read));

    if (invalid.length === 0 && unknown.length === 0) {
      return { values, canWrite: true, needsWrite: false };
    }

    const problems = [
      invalid.length > 0 ? `invalid: ${invalid.join(', ')}` : '',
      unknown.length > 0
        ? `unknown: ${unknown.map((key) => JSON.stringify(key)).join(', ')}`
        : '',
    ]
      .filter((part) => part !== '')
      .join('; ');
    let target: string;
    try {
      target = backupPath();
      fs.copyFileSync(file, target, nodeFs.constants.COPYFILE_EXCL);
    } catch (error) {
      log(
        `${fileName} has bad fields (${problems}) and could not be backed up (${errorCode(error)}); using defaults for them and not writing ${fileName} this run`,
        'error',
      );
      return { values, canWrite: false, needsWrite: false };
    }
    log(
      `${fileName} has bad fields (${problems}); copied it to ${path.basename(target)}, using defaults for invalid fields, dropping unknown ones`,
      'warn',
    );
    return { values, canWrite: true, needsWrite: true };
  }

  const loaded = load();
  const canWrite = loaded.canWrite;
  let values: SettingsValues = loaded.values;
  let rev = 0;
  let dirty = loaded.needsWrite;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<SettingsListener>();

  function state(): SettingsState {
    return { rev, values };
  }

  /** Writes the current values via temp + rename when there is anything to write. */
  function writeNow(): void {
    if (!canWrite || !dirty) {
      return;
    }
    const checked = settingsValuesSchema.safeParse(values);
    if (!checked.success) {
      log(`not writing ${fileName}: the values fail the schema`, 'error');
      return;
    }
    const text = `${JSON.stringify({ schemaVersion, ...checked.data }, null, 2)}\n`;
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // flush: fsync the temp file before the rename, so a power loss
      // cannot leave an empty settings.json behind.
      fs.writeFileSync(temp, text, { encoding: 'utf8', flush: true });
      fs.renameSync(temp, file);
      dirty = false;
    } catch (error) {
      log(
        `cannot write ${fileName} (${errorCode(error)}); keeping the values in memory and retrying on the next flush`,
        'error',
      );
      try {
        fs.unlinkSync(temp);
      } catch {
        // The temp file may never have been created.
      }
    }
  }

  function scheduleFlush(): void {
    if (!canWrite || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      writeNow();
    }, SETTINGS_FLUSH_DEBOUNCE_MS);
  }

  function notify(): void {
    const current = state();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  if (dirty) {
    writeNow();
  }

  return {
    canWrite,

    get: state,

    patch(patch) {
      const { baseRev, ops } = settingsPatchSchema.parse(patch);
      const merged = baseRev !== rev;
      if (baseRev > rev) {
        log(
          `patch baseRev ${baseRev} is ahead of rev ${rev}; applying it to the current values`,
          'warn',
        );
      }
      const next: Record<string, unknown> = { ...values };
      for (const op of ops) {
        next[op.field] = op.value;
      }
      const nextValues = settingsValuesSchema.parse(next);
      const changed = SETTINGS_FIELDS.filter(
        (field) => !sameValue(values[field], nextValues[field]),
      );
      if (changed.length === 0) {
        return { rev, merged };
      }
      values = Object.freeze(nextValues);
      rev += 1;
      dirty = true;
      log(
        `changed ${changed.join(', ')} (rev ${rev}${merged ? ', merged' : ''})`,
      );
      scheduleFlush();
      notify();
      return { rev, merged };
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    flushSync() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        writeNow();
      } catch (error) {
        log(`flush failed (${errorCode(error)})`, 'error');
      }
    },
  };
}

/**
 * Writes pending settings when the app quits (`will-quit`), before Electron
 * exits. Listeners run in the order they were added, so anything registered
 * on `will-quit` after this call runs after the flush.
 */
export function flushSettingsOnQuit(
  app: { on(event: 'will-quit', listener: () => void): unknown },
  store: Pick<SettingsStore, 'flushSync'>,
): void {
  app.on('will-quit', () => {
    store.flushSync();
  });
}
