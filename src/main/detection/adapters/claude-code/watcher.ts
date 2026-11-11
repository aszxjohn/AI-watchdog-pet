/**
 * main/detection/adapters/claude-code/watcher: following Claude Code's
 * projects folder for changes (Story 2.4). The adapter sees only the
 * TranscriptWatcher interface; watchWithChokidar is the real one (chokidar
 * 5.0.0), and tests hand in a fake. Watching opens nothing to read and
 * writes nothing.
 */
import { watch } from 'chokidar';
import type { WatchedStats } from './paths';

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

/**
 * Starts watching `root`, existing, and what is below it for which
 * `follow(path, stats)` is true; reports only changes after the initial
 * scan.
 */
export type WatchTranscripts = (
  root: string,
  follow: (entry: string, stats?: WatchedStats) => boolean,
  handlers: WatchHandlers,
) => TranscriptWatcher;

/** The real watcher, on chokidar. */
export const watchWithChokidar: WatchTranscripts = (root, follow, on) => {
  const watcher = watch(root, {
    // The adapter replays what was there itself, once the scan is done.
    ignoreInitial: true,
    // Only what is really under the root: <cwd>/<id>/subagents/<file>.
    followSymlinks: false,
    depth: 3,
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
