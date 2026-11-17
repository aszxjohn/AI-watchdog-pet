/**
 * main/pool (Story 2.8, AD-23): the only owner and writer of
 * assignments.json, which remembers the sessions the user released and,
 * since Story 3.4, the character each session was assigned (main/pool's
 * assigner, assign.ts, decides those and hands them here to be saved). A
 * released session is still detected as usual and gets no character. The
 * store offers its `pool` section the way main/detection offers its own
 * (get() and onChange()); it does not depend on main/detection, nor
 * main/detection on it: main.ts hands the assigner detection's start-up
 * sync, and the assigner sweeps the store.
 *
 * Loading follows main/settings' rules and never loses the user's file:
 * - no file: nothing released, no assignment; nothing is created;
 * - unreadable file (e.g. EACCES): nothing released, no assignment, and this
 *   run never writes;
 * - unusable file (not JSON, not an object, bad `schemaVersion`, newer than
 *   this build, a migration that fails, `released` or `assignments` missing
 *   or not a list, or an unknown field): renamed to
 *   `assignments.json.broken-<YYYYMMDD-HHmmss>` and nothing is released;
 *   if the rename fails, this run never writes;
 * - bad entries (Story 3.4), checked one by one: a released key that fails
 *   the shared schema, an assignment that does, or one naming a session key
 *   or an actor id an earlier one named. Those entries are dropped and the
 *   rest kept; the original is copied to a `.broken-` file and the
 *   corrected file is written back at once (as main/settings does with bad
 *   fields); if the copy fails, this run never writes.
 * A version-1 file (released keys only) is migrated forward to version 2
 * with no assignment. The released keys read are sorted, each once; the
 * assignments are sorted by session key.
 *
 * Changes:
 * - setReleased releases a key or shows it again. One that changes nothing
 *   is no change: no notification, nothing written.
 * - sweep(reported, unconfirmed), once, after detection's start-up sync:
 *   keeps the released keys detection reported since start and drops the
 *   rest (sessions saved from an earlier run that did not come back),
 *   except that a key whose source is in `unconfirmed` (its adapter was
 *   still syncing at the deadline, or failed to start: it may not have
 *   reported every session) is kept unswept (Epic 2 close-out B1). A key
 *   released and ended within one run stays released until the next
 *   start's sweep. The assignments are swept by main/pool's assigner,
 *   which calls this.
 * - setAssignments takes the assignments the assigner decided; nobody is
 *   told (the assigner publishes the actors), the file is written as below.
 * - A change shows up in get() and onChange at once; the file is written
 *   once POOL_FLUSH_DEBOUNCE_MS after the first change not yet on disk,
 *   through main/persist (temp file, fsync, rename). flushSync() writes
 *   what is pending right now (app quit). A failed write is logged, its
 *   temp file removed, and the keys and assignments kept in memory for the
 *   next flush; the panel is not told (the release holds for this run, and
 *   the assignments are worked out again at the next start).
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
  splitSessionKey,
} from '../../shared/detection-events';
import {
  POOL_SCHEMA_VERSION,
  poolAssignmentSchema,
  poolFileSchema,
  sortedSessionKeys,
  type PoolAssignment,
} from '../../shared/pool';
import type { SourceCode } from '../../shared/sources';
import type { StageViewPoolSections } from '../../shared/stage-view';
import { z } from '../../shared/zod-setup';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import {
  brokenBackupPath,
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
  copyFileSync(from: string, to: string, mode: number): void;
}

/**
 * Forward-only migrations of assignments.json. 1 → 2 (Story 3.4): the
 * released keys stay, with no assignment.
 */
export const POOL_MIGRATIONS: FileMigrations = Object.freeze({
  1: (data: Record<string, unknown>) => ({ ...data, assignments: [] }),
});

/**
 * The file's shape, checked before its entries: the two lists are there
 * and nothing else is. Each entry is checked on its own afterwards.
 */
const poolFileShapeSchema = z.strictObject({
  schemaVersion: z.literal(POOL_SCHEMA_VERSION),
  released: z.array(z.unknown()),
  assignments: z.array(z.unknown()),
});

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
   * `reported`, except those whose source is in `unconfirmed`. Only the
   * first call does anything. The assignments are left to the assigner.
   */
  sweep(
    reported: ReadonlySet<SessionKey>,
    unconfirmed: ReadonlySet<SourceCode>,
  ): void;
  /**
   * The saved assignments (Story 3.4), sorted by session key: those read
   * from the file until main/pool's assigner hands newer ones.
   */
  assignments(): readonly PoolAssignment[];
  /**
   * Takes `next` as the assignments to save (sorted by session key on the
   * way), written with the released keys after the same debounce. Nobody
   * is told: the assigner publishes the actors itself. Answers whether that
   * changed anything. Throws, changing nothing, when `next` fails the
   * shared file schema (an entry, or a session key or actor id twice).
   */
  setAssignments(next: readonly PoolAssignment[]): boolean;
  /** Writes pending changes now. Never throws. */
  flushSync(): void;
  /** False once the original file could not be kept safe this run. */
  readonly canWrite: boolean;
}

interface Loaded {
  readonly released: readonly SessionKey[];
  readonly assignments: readonly PoolAssignment[];
  readonly canWrite: boolean;
  /** Bad entries were dropped: the corrected file is written back at once. */
  readonly needsWrite: boolean;
}

const NOTHING_RELEASED: readonly SessionKey[] = Object.freeze([]);
const NO_ASSIGNMENTS: readonly PoolAssignment[] = Object.freeze([]);

/** Nothing released and no assignment, written (or not) as `canWrite` says. */
function empty(canWrite: boolean): Loaded {
  return {
    released: NOTHING_RELEASED,
    assignments: NO_ASSIGNMENTS,
    canWrite,
    needsWrite: false,
  };
}

/** Code-unit order of session keys. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `list` sorted by session key, frozen, each entry a frozen copy. */
function sortedAssignments(
  list: readonly PoolAssignment[],
): readonly PoolAssignment[] {
  return Object.freeze(
    [...list]
      .sort((a, b) => compareKeys(a.sessionKey, b.sessionKey))
      .map(({ sessionKey, actorId, characterKey }) =>
        Object.freeze({ sessionKey, actorId, characterKey }),
      ),
  );
}

function sameAssignments(
  a: readonly PoolAssignment[],
  b: readonly PoolAssignment[],
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        y !== undefined &&
        x.sessionKey === y.sessionKey &&
        x.actorId === y.actorId &&
        x.characterKey === y.characterKey
      );
    })
  );
}

/** What the entries of a well-shaped file hold, and how many were bad. */
interface ReadEntries {
  readonly released: readonly SessionKey[];
  readonly assignments: readonly PoolAssignment[];
  readonly badReleased: number;
  readonly badAssignments: number;
}

/**
 * Checks each entry on its own: a released key against the shared schema;
 * an assignment against it too, and against the assignments before it (a
 * session key or actor id named again is a bad entry, the first one wins).
 */
function readEntries(
  released: readonly unknown[],
  assignments: readonly unknown[],
): ReadEntries {
  const keys: SessionKey[] = [];
  let badReleased = 0;
  for (const entry of released) {
    const parsed = sessionKeySchema.safeParse(entry);
    if (parsed.success) {
      keys.push(parsed.data);
    } else {
      badReleased += 1;
    }
  }
  const kept: PoolAssignment[] = [];
  const sessions = new Set<string>();
  const actors = new Set<string>();
  let badAssignments = 0;
  for (const entry of assignments) {
    const parsed = poolAssignmentSchema.safeParse(entry);
    if (
      !parsed.success ||
      sessions.has(parsed.data.sessionKey) ||
      actors.has(parsed.data.actorId)
    ) {
      badAssignments += 1;
      continue;
    }
    sessions.add(parsed.data.sessionKey);
    actors.add(parsed.data.actorId);
    kept.push(parsed.data);
  }
  return { released: keys, assignments: kept, badReleased, badAssignments };
}

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

function assigned(count: number): string {
  return `${count} ${count === 1 ? 'assignment' : 'assignments'}`;
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
      return empty(false);
    }
    log(
      `${fileName} is unusable (${reason}); renamed it to ${path.basename(target)} and starting with nothing released`,
      'error',
    );
    return empty(true);
  }

  function load(): Loaded {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        log(`no ${fileName}; nothing released`);
        return empty(true);
      }
      log(
        `cannot read ${fileName} (${code}); starting with nothing released and not writing ${fileName} this run`,
        'error',
      );
      return empty(false);
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
    // The version is settled above; the shape is checked here and each
    // entry on its own below.
    const shaped = poolFileShapeSchema.safeParse({
      ...content,
      schemaVersion: POOL_SCHEMA_VERSION,
    });
    if (!shaped.success) {
      return setAside(
        `does not match the schema (fields: ${failedFields(shaped.error.issues)})`,
      );
    }
    const entries = readEntries(shaped.data.released, shaped.data.assignments);
    const keys = Object.freeze(sortedSessionKeys(entries.released));
    const kept = sortedAssignments(entries.assignments);
    const bad = entries.badReleased + entries.badAssignments;
    if (bad > 0) {
      return keepGoodEntries(keys, kept, entries);
    }
    log(
      `loaded ${fileName}: ${released(keys.length)}, ${assigned(kept.length)}`,
    );
    return {
      released: keys,
      assignments: kept,
      canWrite: true,
      needsWrite: false,
    };
  }

  /**
   * Some entries were bad: keeps the rest, copies the original aside and
   * has the corrected file written back at once. Counts only in the log.
   */
  function keepGoodEntries(
    keys: readonly SessionKey[],
    kept: readonly PoolAssignment[],
    { badReleased, badAssignments }: ReadEntries,
  ): Loaded {
    const problems = `${released(badReleased)}, ${assigned(badAssignments)}`;
    let target: string;
    try {
      target = brokenBackupPath(fs, file, now());
      fs.copyFileSync(file, target, nodeFs.constants.COPYFILE_EXCL);
    } catch (error) {
      log(
        `${fileName} has bad entries (${problems}) and could not be backed up (${errorCode(error)}); dropping them and not writing ${fileName} this run`,
        'error',
      );
      return {
        released: keys,
        assignments: kept,
        canWrite: false,
        needsWrite: false,
      };
    }
    log(
      `${fileName} has bad entries (${problems}); copied it to ${path.basename(target)} and dropping them: ${released(keys.length)}, ${assigned(kept.length)} kept`,
      'warn',
    );
    return {
      released: keys,
      assignments: kept,
      canWrite: true,
      needsWrite: true,
    };
  }

  const loaded = load();
  const canWrite = loaded.canWrite;
  let keys: readonly SessionKey[] = loaded.released;
  let saved: readonly PoolAssignment[] = loaded.assignments;
  let section = sectionOf(keys);
  let dirty = loaded.needsWrite;
  let swept = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<PoolListener>();

  /**
   * Writes the released keys and the assignments via main/persist when
   * anything is pending.
   */
  function writeNow(): void {
    if (!canWrite || !dirty) {
      return;
    }
    const text = `${JSON.stringify({ schemaVersion, released: keys, assignments: saved }, null, 2)}\n`;
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

  if (dirty) {
    writeNow();
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

    assignments: () => saved,

    setAssignments(next) {
      const sorted = sortedAssignments(next);
      poolFileSchema.shape.assignments.parse(sorted);
      if (sameAssignments(saved, sorted)) {
        return false;
      }
      saved = sorted;
      dirty = true;
      scheduleFlush();
      return true;
    },

    sweep(reported, unconfirmed) {
      if (swept) {
        return;
      }
      swept = true;
      /** Kept only because their source is unconfirmed. */
      let unswept = 0;
      const kept = keys.filter((key) => {
        if (reported.has(key)) {
          return true;
        }
        if (unconfirmed.has(splitSessionKey(key).source)) {
          unswept += 1;
          return true;
        }
        return false;
      });
      const dropped = keys.length - kept.length;
      // Counts and source codes only. With every source confirmed, the
      // line reads as it did before Epic 2's close-out.
      const unconfirmedNote =
        unconfirmed.size === 0
          ? ''
          : `; ${unswept} kept unreported from unconfirmed sources: ${[...unconfirmed].join(', ')}`;
      log(
        `start-up sweep: kept ${kept.length}, dropped ${dropped} (${reported.size} sessions reported${unconfirmedNote})`,
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
