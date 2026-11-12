/**
 * main/pool (Story 2.8, AD-23): the only owner and writer of
 * assignments.json, which remembers the sessions the user released. A
 * released session is still detected as usual; for now only the panel marks
 * it (Story 3.4 gives it no character). The store offers StageView its
 * `pool` section the way main/detection offers its own (get() and
 * onChange()); it does not depend on main/detection, nor main/detection on
 * it: main.ts hands it detection's start-up sync.
 *
 * Loading follows main/settings' rules and never loses the user's file:
 * - no file: nothing released; nothing is created;
 * - unreadable file (e.g. EACCES): nothing released, and this run never
 *   writes;
 * - unusable file (not JSON, not an object, bad `schemaVersion`, newer than
 *   this build, a migration that fails, or content that fails the shared
 *   file schema): renamed to `assignments.json.broken-<YYYYMMDD-HHmmss>`
 *   and nothing is released; if the rename fails, this run never writes.
 * The released keys read are sorted, each once.
 *
 * Changes:
 * - setReleased releases a key or shows it again. One that changes nothing
 *   is no change: no notification, nothing written.
 * - sweep(reported), once, after detection's start-up sync: keeps the
 *   released keys detection reported since start and drops the rest
 *   (sessions saved from an earlier run that did not come back). A key
 *   released and ended within one run stays released until the next
 *   start's sweep.
 * - A change shows up in get() and onChange at once; the file is written
 *   once POOL_FLUSH_DEBOUNCE_MS after the first change not yet on disk,
 *   through main/persist (temp file, fsync, rename). flushSync() writes
 *   what is pending right now (app quit). A failed write is logged, its
 *   temp file removed, and the keys kept in memory for the next flush; the
 *   panel is not told (the release holds for this run).
 *
 * fs is synchronous on purpose, as in main/settings. Log lines carry counts,
 * reasons and error codes only, never a session key, a path or file
 * contents.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { POOL_FLUSH_DEBOUNCE_MS } from '../../shared/constants';
import {
  type SessionKey,
  sessionKeySchema,
} from '../../shared/detection-events';
import {
  POOL_SCHEMA_VERSION,
  poolFileSchema,
  sortedSessionKeys,
} from '../../shared/pool';
import type { StageViewPoolSections } from '../../shared/stage-view';
import type { z } from '../../shared/zod-setup';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import {
  renameBroken,
  writeFileAtomic,
  type AtomicWriteFs,
  type BrokenFileFs,
} from '../persist/files';
import {
  isPlainObject,
  migrateFile,
  type FileMigrations,
} from '../persist/migrate';

/** The parts of node:fs the store uses; tests inject failures. */
export interface PoolFs extends AtomicWriteFs, BrokenFileFs {
  readFileSync(file: string, encoding: 'utf8'): string;
}

/** Forward-only migrations of assignments.json; empty while it is at 1. */
export const POOL_MIGRATIONS: FileMigrations = Object.freeze({});

export interface PoolStoreOptions {
  /** Path of assignments.json (`userData/assignments.json`). */
  readonly file: string;
  readonly fs?: PoolFs;
  readonly now?: () => number;
  readonly migrations?: FileMigrations;
  /** The version this build reads and writes; tests raise it to run migrations. */
  readonly schemaVersion?: number;
}

export type PoolListener = (sections: StageViewPoolSections) => void;

export interface PoolStore {
  /** The `pool` section: the released keys, sorted, each once. */
  get(): StageViewPoolSections;
  /** Called after every change. Returns an unsubscribe. */
  onChange(listener: PoolListener): () => void;
  /**
   * Releases `sessionKey` (true) or shows it again (false); answers whether
   * that changed anything. Throws only if `sessionKey` fails the shared
   * schema.
   */
  setReleased(sessionKey: SessionKey, released: boolean): boolean;
  /**
   * After detection's start-up sync: drops every released key not in
   * `reported`. Only the first call does anything.
   */
  sweep(reported: ReadonlySet<SessionKey>): void;
  /** Writes pending changes now. Never throws. */
  flushSync(): void;
  /** False once the original file could not be kept safe this run. */
  readonly canWrite: boolean;
}

interface Loaded {
  readonly released: readonly SessionKey[];
  readonly canWrite: boolean;
}

const NOTHING_RELEASED: readonly SessionKey[] = Object.freeze([]);

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('pool', message, level);
}

/** The field paths a failed parse names, `(root)` for the object itself. */
function failedFields(issues: z.ZodError['issues']): string {
  const paths = new Set<string>();
  for (const issue of issues) {
    const named =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    for (const part of named) {
      paths.add(part.length === 0 ? '(root)' : part.map(String).join('.'));
    }
  }
  return [...paths].join(', ');
}

/** The `pool` section for `keys`, a copy StageView may keep. */
function sectionOf(keys: readonly SessionKey[]): StageViewPoolSections {
  return { pool: { released: [...keys] } };
}

function released(count: number): string {
  return `${count} released`;
}

export function loadPool({
  file,
  fs = nodeFs,
  now = Date.now,
  migrations = POOL_MIGRATIONS,
  schemaVersion = POOL_SCHEMA_VERSION,
}: PoolStoreOptions): PoolStore {
  const fileName = path.basename(file);

  /** Moves an unusable file aside and starts with nothing released. */
  function setAside(reason: string): Loaded {
    let target: string;
    try {
      target = renameBroken(fs, file, now());
    } catch (error) {
      log(
        `${fileName} is unusable (${reason}) and could not be renamed (${errorCode(error)}); starting with nothing released and not writing ${fileName} this run`,
        'error',
      );
      return { released: NOTHING_RELEASED, canWrite: false };
    }
    log(
      `${fileName} is unusable (${reason}); renamed it to ${path.basename(target)} and starting with nothing released`,
      'error',
    );
    return { released: NOTHING_RELEASED, canWrite: true };
  }

  function load(): Loaded {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        log(`no ${fileName}; nothing released`);
        return { released: NOTHING_RELEASED, canWrite: true };
      }
      log(
        `cannot read ${fileName} (${code}); starting with nothing released and not writing ${fileName} this run`,
        'error',
      );
      return { released: NOTHING_RELEASED, canWrite: false };
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
    let content: Record<string, unknown> = data;
    if (version !== schemaVersion) {
      const migrated = migrateFile(data, version, schemaVersion, migrations);
      if (!migrated.ok) {
        return setAside(migrated.reason);
      }
      log(
        `migrated ${fileName} from schemaVersion ${version} to ${schemaVersion}`,
      );
      content = migrated.data;
    }
    // The version is settled above; the shared schema checks the rest.
    const parsed = poolFileSchema.safeParse({
      ...content,
      schemaVersion: POOL_SCHEMA_VERSION,
    });
    if (!parsed.success) {
      return setAside(
        `does not match the schema (fields: ${failedFields(parsed.error.issues)})`,
      );
    }
    const keys = Object.freeze(sortedSessionKeys(parsed.data.released));
    log(`loaded ${fileName}: ${released(keys.length)}`);
    return { released: keys, canWrite: true };
  }

  const loaded = load();
  const canWrite = loaded.canWrite;
  let keys: readonly SessionKey[] = loaded.released;
  let section = sectionOf(keys);
  let dirty = false;
  let swept = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<PoolListener>();

  /** Writes the released keys via main/persist when anything is pending. */
  function writeNow(): void {
    if (!canWrite || !dirty) {
      return;
    }
    const text = `${JSON.stringify({ schemaVersion, released: keys }, null, 2)}\n`;
    try {
      writeFileAtomic(fs, file, text);
      dirty = false;
    } catch (error) {
      log(
        `cannot write ${fileName} (${errorCode(error)}); keeping the released sessions in memory and retrying on the next flush`,
        'error',
      );
    }
  }

  function scheduleFlush(): void {
    if (!canWrite || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      writeNow();
    }, POOL_FLUSH_DEBOUNCE_MS);
  }

  /** Takes `next` as the released keys: saved later, heard now. */
  function change(next: readonly SessionKey[]): void {
    keys = Object.freeze([...next]);
    section = sectionOf(keys);
    dirty = true;
    scheduleFlush();
    const current = section;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  return {
    canWrite,

    get: () => section,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setReleased(sessionKey, release) {
      const key = sessionKeySchema.parse(sessionKey);
      if (keys.includes(key) === release) {
        return false;
      }
      const next = release
        ? sortedSessionKeys([...keys, key])
        : keys.filter((kept) => kept !== key);
      log(
        `${release ? 'released a session' : 'showed a session again'} (${released(next.length)})`,
      );
      change(next);
      return true;
    },

    sweep(reported) {
      if (swept) {
        return;
      }
      swept = true;
      const kept = keys.filter((key) => reported.has(key));
      const dropped = keys.length - kept.length;
      log(
        `start-up sweep: kept ${kept.length}, dropped ${dropped} (${reported.size} sessions reported)`,
      );
      if (dropped > 0) {
        change(kept);
      }
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
