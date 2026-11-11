/**
 * main/detection/adapters/jsonl/watcher: following a records folder for
 * changes (Story 2.4; shared since Story 2.6). The adapter sees only the
 * TranscriptWatcher interface; watchWithChokidar is the real one (chokidar
 * 5.0.0), and tests hand in a fake. Watching opens nothing to read and
 * writes nothing.
 *
 * Which paths the watcher follows is the source's rule; shouldFollow holds
 * the part every source shares (the root, recency, the stats' types).
 */
import path from 'node:path';
import { watch } from 'chokidar';

/** What the watcher reports. */
export interface WatchHandlers {
  /** The initial scan is done; events from now on are changes. */
  ready(): void;
  /** A watched file was added (or, unwatched until now, changed). */
  added(file: string): void;
  /** A watched file changed. */
  changed(file: string): void;
  /** A watched file was removed. */
  removed(file: string): void;
  /**
   * A watched folder was removed. For the root itself, nothing more comes:
   * the watcher does not report it coming back.
   */
  folderRemoved(dir: string): void;
  /** The watcher hit an error; it keeps running. */
  failed(error: unknown): void;
}

export interface TranscriptWatcher {
  /** Stops watching. */
  close(): Promise<void>;
}

/** What the watcher knows of a path when it asks whether to watch it. */
export interface WatchedStats {
  isFile(): boolean;
  isDirectory(): boolean;
  /**
   * A BigInt on Windows: chokidar's readdirp asks for BigInt stats there,
   * and a BigInt cannot be mixed with numbers (it throws a TypeError).
   */
  readonly mtimeMs: number | bigint;
}

/** How a watcher is set up. */
export interface WatchOptions {
  /** How many folders below the root it looks (0: the root's own entries). */
  readonly depth: number;
  /** Whether to watch `entry` (asked by name first, then with its stats). */
  readonly follow: (entry: string, stats?: WatchedStats) => boolean;
}

/**
 * Starts watching `root`, existing, and what is below it, down to
 * `options.depth`, for which `options.follow(path, stats)` is true; reports
 * only changes after the initial scan.
 */
export type WatchTranscripts = (
  root: string,
  options: WatchOptions,
  handlers: WatchHandlers,
) => TranscriptWatcher;

/** The real watcher, on chokidar. */
export const watchWithChokidar: WatchTranscripts = (
  root,
  { depth, follow },
  on,
) => {
  const watcher = watch(root, {
    // The adapter replays what was there itself, once the scan is done.
    ignoreInitial: true,
    // Only what is really under the root.
    followSymlinks: false,
    depth,
    ignored: (entry, stats) => !follow(entry, stats),
  });
  watcher.on('ready', () => {
    on.ready();
  });
  watcher.on('add', (file) => {
    on.added(file);
  });
  watcher.on('change', (file) => {
    on.changed(file);
  });
  watcher.on('unlink', (file) => {
    on.removed(file);
  });
  watcher.on('unlinkDir', (dir) => {
    on.folderRemoved(dir);
  });
  watcher.on('error', (error) => {
    on.failed(error);
  });
  return {
    close: () => watcher.close(),
  };
};

/** `file`'s parts below `root`; null when it is not below it. */
export function partsBelow(root: string, file: string): string[] | null {
  const relative = path.relative(root, file);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep);
}

/**
 * What a path below the root is to the watcher, by its parts below the
 * root: a transcript, a folder transcripts live in, or neither.
 */
export type WatchedKind = 'transcript' | 'folder' | null;

/**
 * Whether the watcher should follow `entry`: the root; the folders
 * `kindOf` names; the transcripts it names that were modified recently
 * (`recent(mtimeMs)`). Older transcripts are left alone until they change:
 * the folder holding one notices, asks again, and the watcher reports the
 * file as added. That keeps one watch handle per recently used transcript,
 * not one per transcript ever written. Without stats, only the names are
 * checked.
 */
export function shouldFollow(
  root: string,
  entry: string,
  stats: WatchedStats | undefined,
  recent: (mtimeMs: number) => boolean,
  kindOf: (parts: readonly string[]) => WatchedKind,
): boolean {
  if (path.relative(root, entry) === '') {
    return true;
  }
  const parts = partsBelow(root, entry);
  if (parts === null) {
    return false;
  }
  const kind = kindOf(parts);
  if (stats === undefined) {
    return kind !== null;
  }
  if (stats.isFile()) {
    return kind === 'transcript' && recent(Number(stats.mtimeMs));
  }
  return stats.isDirectory() && kind === 'folder';
}
