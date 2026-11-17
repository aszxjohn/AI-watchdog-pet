/**
 * main/packs (Story 3.2, AD-23): the only owner and writer of
 * `userData/packs/`: `index.json` lists the installed packs (each pack id
 * once, with one version), and each one's files are in
 * `packs/<packId>/<version>/`. The store offers StageView its `packs`
 * section the way main/pool offers `pool` (get() and onChange()); it
 * depends on neither main/detection nor main/pool. Each pack in the section
 * says whether its `apiVersion` fits this stage (Story 3.5): one installed
 * before the app changed its API version may not.
 *
 * Loading follows main/pool's rules and never loses the user's file:
 * - no index.json: no packs installed; nothing is created;
 * - unreadable (e.g. EACCES): no packs installed, and this run never
 *   writes index.json (so nothing can be installed);
 * - unusable (not JSON, not an object, bad `schemaVersion`, newer than
 *   this build, a migration that fails, or content that fails the shared
 *   schema): renamed to `index.json.broken-<YYYYMMDD-HHmmss>` and no packs
 *   installed; if the rename fails, this run never writes.
 * The entries read are sorted by pack id.
 *
 * Then, once, the start-up cleanup of what an install left behind (a crash,
 * a failed rollback). Always: the `.staging-…` folders and a leftover
 * `index.json.tmp` go. Only when index.json was read is it the truth:
 * - a `.backup-<packId>@<version>@…` folder of the version index.json
 *   names, whose folder is missing, goes back in place (an install that
 *   stopped halfway through replacing the same version); other backups go;
 * - the version folders of an installed pack other than its installed
 *   version go, and so do the folders of pack ids it does not list.
 * With no index.json, or one unreadable or set aside, pack folders and
 * backups stay (nothing says which are still wanted) and one line counts
 * them. Only names this module could have made are touched (a pack id, a
 * version, its own prefixes); one line counts what went.
 *
 * Last, a pack whose folder (`packs/<id>/<version>/`) is missing is left
 * out of the list, with an error line each; index.json is not rewritten
 * for it (the next save drops it).
 *
 * Changes come only through save() (install.ts): index.json is written
 * through main/persist (temp file, fsync, rename) and only then does the
 * store take the new entries and tell its listeners. fs is synchronous on
 * purpose, as in main/settings and main/pool. Log lines carry counts,
 * reasons, error codes and pack ids only, never a path or file contents.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  checkApiCompatibility,
  packIdSchema,
  packVersionSchema,
} from '../../shared/pack-api';
import {
  PACKS_SCHEMA_VERSION,
  packIndexFileSchema,
  type PackIndexEntry,
  type StagePack,
} from '../../shared/packs';
import type { StageViewPacksSections } from '../../shared/stage-view';
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

/** The index's file name inside the packs folder. */
export const PACKS_INDEX_FILE = 'index.json';

/**
 * Prefixes of the temporary folders install.ts makes in the packs folder:
 * the new files before they go in place, and an installed folder of the
 * same version while it is being replaced. A pack id cannot start with `.`.
 */
export const STAGING_PREFIX = '.staging-';
export const BACKUP_PREFIX = '.backup-';

/** What writeFileAtomic leaves behind when it stops before its rename. */
const INDEX_TEMP_FILE = `${PACKS_INDEX_FILE}.tmp`;

/**
 * The name of the folder an installed version waits in while install.ts
 * replaces it with the same version: `.backup-<packId>@<version>@<token>`
 * (neither an id nor a version has `@`), so the start-up cleanup knows
 * where it goes back.
 */
export function backupFolderName(
  packId: string,
  version: string,
  token: string,
): string {
  return `${BACKUP_PREFIX}${packId}@${version}@${token}`;
}

/** The pack and version a backupFolderName names, if it is one. */
function backupOf(
  name: string,
): { readonly packId: string; readonly version: string } | undefined {
  if (!name.startsWith(BACKUP_PREFIX)) {
    return undefined;
  }
  const [packId, version] = name.slice(BACKUP_PREFIX.length).split('@');
  if (
    packId === undefined ||
    version === undefined ||
    !packIdSchema.safeParse(packId).success ||
    !packVersionSchema.safeParse(version).success
  ) {
    return undefined;
  }
  return { packId, version };
}

/** What the cleanup needs of a directory entry. */
export interface PacksDirEntry {
  readonly name: string;
  isDirectory(): boolean;
}

/** The parts of node:fs the store uses; tests inject failures. */
export interface PacksFs extends AtomicWriteFs, BrokenFileFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(dir: string, options: { withFileTypes: true }): PacksDirEntry[];
  rmSync(target: string, options: { recursive: true; force: true }): void;
}

/** Forward-only migrations of index.json; empty while it is at 1. */
export const PACKS_MIGRATIONS: FileMigrations = Object.freeze({});

export interface PacksStoreOptions {
  /** The packs folder (`userData/packs`). */
  readonly dir: string;
  readonly fs?: PacksFs;
  readonly now?: () => number;
  readonly migrations?: FileMigrations;
  /** The version this build reads and writes; tests raise it to run migrations. */
  readonly schemaVersion?: number;
}

export type PacksListener = (sections: StageViewPacksSections) => void;

export interface PacksStore {
  /** The packs folder. */
  readonly dir: string;
  /** False once index.json could not be kept safe this run. */
  readonly canWrite: boolean;
  /** The `packs` section: the installed packs, sorted by id. */
  get(): StageViewPacksSections;
  /** Called after every change. Returns an unsubscribe. */
  onChange(listener: PacksListener): () => void;
  /** Every installed pack, sorted by id. */
  list(): readonly PackIndexEntry[];
  /** The installed pack of `packId`, if any. */
  find(packId: string): PackIndexEntry | undefined;
  /**
   * Writes index.json with `entries` (sorted by id on the way) and, once it
   * is written, takes them and tells the listeners. Throws what failed
   * (entries that fail the shared schema, a write that fails, or no
   * writing this run); nothing changes then.
   */
  save(entries: readonly PackIndexEntry[]): void;
}

/** How loading went; it decides what the cleanup may remove. */
type LoadOutcome = 'loaded' | 'missing' | 'set-aside' | 'unreadable';

interface Loaded {
  readonly entries: readonly PackIndexEntry[];
  readonly outcome: LoadOutcome;
  readonly canWrite: boolean;
}

const NO_PACKS: readonly PackIndexEntry[] = Object.freeze([]);

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('packs', message, level);
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

/** Sorted by pack id, in code-unit order, frozen. */
function sortedById(
  entries: readonly PackIndexEntry[],
): readonly PackIndexEntry[] {
  return Object.freeze(
    [...entries].sort((a, b) => {
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    }),
  );
}

/**
 * An installed pack as StageView carries it, with whether its `apiVersion`
 * fits this stage (Story 3.5).
 */
function stagePackOf({
  id,
  name,
  version,
  apiVersion,
  characters,
}: PackIndexEntry): StagePack {
  return {
    id,
    name,
    version,
    apiVersion,
    characters: characters.map((character) => ({ ...character })),
    compatibility: checkApiCompatibility(apiVersion),
  };
}

/** The `packs` section for `entries`, a copy StageView may keep. */
function sectionOf(entries: readonly PackIndexEntry[]): StageViewPacksSections {
  return { packs: { installed: entries.map(stagePackOf) } };
}

function packs(count: number): string {
  return `${count} ${count === 1 ? 'pack' : 'packs'}`;
}

export function loadPacks({
  dir,
  fs = nodeFs,
  now = Date.now,
  migrations = PACKS_MIGRATIONS,
  schemaVersion = PACKS_SCHEMA_VERSION,
}: PacksStoreOptions): PacksStore {
  const file = path.join(dir, PACKS_INDEX_FILE);

  /** Moves an unusable index aside and starts with no packs installed. */
  function setAside(reason: string): Loaded {
    let target: string;
    try {
      target = renameBroken(fs, file, now());
    } catch (error) {
      log(
        `${PACKS_INDEX_FILE} is unusable (${reason}) and could not be renamed (${errorCode(error)}); starting with no packs installed and not writing ${PACKS_INDEX_FILE} this run`,
        'error',
      );
      return { entries: NO_PACKS, outcome: 'set-aside', canWrite: false };
    }
    log(
      `${PACKS_INDEX_FILE} is unusable (${reason}); renamed it to ${path.basename(target)} and starting with no packs installed`,
      'error',
    );
    return { entries: NO_PACKS, outcome: 'set-aside', canWrite: true };
  }

  function load(): Loaded {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        log(`no ${PACKS_INDEX_FILE}; no packs installed`);
        return { entries: NO_PACKS, outcome: 'missing', canWrite: true };
      }
      log(
        `cannot read ${PACKS_INDEX_FILE} (${code}); starting with no packs installed and not writing ${PACKS_INDEX_FILE} this run`,
        'error',
      );
      return { entries: NO_PACKS, outcome: 'unreadable', canWrite: false };
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
        `migrated ${PACKS_INDEX_FILE} from schemaVersion ${version} to ${schemaVersion}`,
      );
      content = migrated.data;
    }
    // The version is settled above; the shared schema checks the rest.
    const parsed = packIndexFileSchema.safeParse({
      ...content,
      schemaVersion: PACKS_SCHEMA_VERSION,
    });
    if (!parsed.success) {
      return setAside(
        `does not match the schema (fields: ${failedFields(parsed.error.issues)})`,
      );
    }
    const entries = sortedById(parsed.data.packs);
    log(`loaded ${PACKS_INDEX_FILE}: ${packs(entries.length)}`);
    return { entries, outcome: 'loaded', canWrite: true };
  }

  /** Removes what an install left behind (see the module comment). */
  function cleanUp(loaded: Loaded): void {
    let items: PacksDirEntry[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT') {
        log(
          `start-up cleanup could not list the packs folder (${code})`,
          'error',
        );
      }
      return;
    }
    const authoritative = loaded.outcome === 'loaded';
    const failures = new Set<string>();
    let failed = 0;
    const removed = { temporary: 0, oldVersions: 0, notInstalled: 0 };
    const kept = { packFolders: 0, backups: 0 };
    function remove(target: string, kind: keyof typeof removed): void {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed[kind] += 1;
      } catch (error) {
        failed += 1;
        failures.add(errorCode(error));
      }
    }
    function versionFolder(packId: string, version: string): string {
      return path.join(dir, packId, version);
    }

    // First the temporary names, so a backup is back in place before the
    // pack folders are looked at.
    for (const item of items) {
      const at = path.join(dir, item.name);
      if (!item.isDirectory()) {
        if (item.name === INDEX_TEMP_FILE) {
          remove(at, 'temporary');
        }
        continue;
      }
      if (item.name.startsWith(STAGING_PREFIX)) {
        remove(at, 'temporary');
        continue;
      }
      if (!item.name.startsWith(BACKUP_PREFIX)) {
        continue;
      }
      if (!authoritative) {
        kept.backups += 1;
        continue;
      }
      const backup = backupOf(item.name);
      const installed =
        backup === undefined
          ? undefined
          : loaded.entries.find(
              (entry) =>
                entry.id === backup.packId && entry.version === backup.version,
            );
      if (
        installed !== undefined &&
        !fs.existsSync(versionFolder(installed.id, installed.version))
      ) {
        try {
          fs.mkdirSync(path.join(dir, installed.id), { recursive: true });
          fs.renameSync(at, versionFolder(installed.id, installed.version));
          log(
            `start-up cleanup: put pack ${installed.id} back from its backup`,
            'warn',
          );
        } catch (error) {
          failed += 1;
          failures.add(errorCode(error));
        }
        continue;
      }
      remove(at, 'temporary');
    }

    for (const item of items) {
      if (!item.isDirectory() || !packIdSchema.safeParse(item.name).success) {
        continue;
      }
      if (!authoritative) {
        kept.packFolders += 1;
        continue;
      }
      const at = path.join(dir, item.name);
      const installed = loaded.entries.find((entry) => entry.id === item.name);
      if (installed === undefined) {
        remove(at, 'notInstalled');
        continue;
      }
      let versions: PacksDirEntry[];
      try {
        versions = fs.readdirSync(at, { withFileTypes: true });
      } catch (error) {
        failed += 1;
        failures.add(errorCode(error));
        continue;
      }
      for (const version of versions) {
        if (
          version.isDirectory() &&
          version.name !== installed.version &&
          packVersionSchema.safeParse(version.name).success
        ) {
          remove(path.join(at, version.name), 'oldVersions');
        }
      }
    }

    const total =
      removed.temporary + removed.oldVersions + removed.notInstalled;
    if (total > 0) {
      log(
        `start-up cleanup: removed ${total} leftovers (${removed.temporary} temporary, ${removed.oldVersions} old versions, ${removed.notInstalled} of packs not installed)`,
      );
    }
    if (kept.packFolders + kept.backups > 0) {
      log(
        `start-up cleanup: ${PACKS_INDEX_FILE} was not loaded, so ${kept.packFolders} pack folders and ${kept.backups} backups were kept`,
      );
    }
    if (failed > 0) {
      log(
        `start-up cleanup could not remove or restore ${failed} leftovers (${[...failures].join(', ')})`,
        'error',
      );
    }
  }

  /** The entries whose folder is there; logs each one that is not. */
  function present(all: readonly PackIndexEntry[]): readonly PackIndexEntry[] {
    return Object.freeze(
      all.filter((entry) => {
        if (fs.existsSync(path.join(dir, entry.id, entry.version))) {
          return true;
        }
        log(
          `pack ${entry.id}: its folder is missing; leaving it out (${PACKS_INDEX_FILE} not rewritten)`,
          'error',
        );
        return false;
      }),
    );
  }

  const loaded = load();
  cleanUp(loaded);
  const canWrite = loaded.canWrite;
  let entries = present(loaded.entries);
  let section = sectionOf(entries);
  const listeners = new Set<PacksListener>();

  return {
    dir,
    canWrite,

    get: () => section,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    list: () => entries,

    find: (packId) => entries.find((entry) => entry.id === packId),

    save(next) {
      if (!canWrite) {
        throw new Error(`${PACKS_INDEX_FILE} is not written this run`);
      }
      const sorted = sortedById(next);
      // Never write an index this build could not read back.
      packIndexFileSchema.parse({
        schemaVersion: PACKS_SCHEMA_VERSION,
        packs: sorted,
      });
      writeFileAtomic(
        fs,
        file,
        `${JSON.stringify({ schemaVersion, packs: sorted }, null, 2)}\n`,
      );
      entries = sorted;
      section = sectionOf(entries);
      const current = section;
      for (const listener of listeners) {
        try {
          listener(current);
        } catch (error) {
          log(`a change listener failed (${errorCode(error)})`, 'error');
        }
      }
    },
  };
}
