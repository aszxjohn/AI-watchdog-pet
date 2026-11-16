/**
 * main/packs (Story 3.2's second half): the `.awpet` files the app is
 * handed from outside, besides the 匯入角色包… button: a second launch's
 * arguments, the first launch's arguments, and macOS `open-file`.
 *
 * - Only an existing regular file whose extension is `.awpet` (any case)
 *   counts; every other argument (switches, other files, folders, paths
 *   that do not exist) is ignored. A relative argument is taken from the
 *   launch's working folder.
 * - The files are held until the app is ready (`open-file` may come before
 *   `ready`), then handed on in the order they came; after that, at once.
 *
 * Nothing here logs: main.ts says what came in, without the path.
 */
import nodeFs from 'node:fs';
import path from 'node:path';

/** The extension of a character pack file. */
export const PACK_FILE_EXTENSION = '.awpet';

/** The part of node:fs the checks use; tests inject it. */
export interface PackFileFs {
  statSync(file: string): { isFile(): boolean };
}

/** Whether `file` names an existing regular file with the `.awpet` extension. */
export function isPackFile(file: string, fs: PackFileFs = nodeFs): boolean {
  if (path.extname(file).toLowerCase() !== PACK_FILE_EXTENSION) {
    return false;
  }
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The first `.awpet` in a launch's arguments (`argv`, as `process.argv` or
 * `second-instance` gives them, the executable included), resolved against
 * `cwd`; null when there is none. Switches (`-…`) are skipped.
 */
export function packFileFromArgv(
  argv: readonly unknown[],
  cwd: string,
  fs: PackFileFs = nodeFs,
): string | null {
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg === '' || arg.startsWith('-')) {
      continue;
    }
    const file = path.resolve(cwd, arg);
    if (isPackFile(file, fs)) {
      return file;
    }
  }
  return null;
}

export interface LaunchFileQueue {
  /** Hands `file` on now when ready, else once ready. */
  add(file: string): void;
  /** The app is ready: hands on the files held so far, in order. */
  ready(): void;
}

/**
 * Holds files until ready() (see the module comment). `open` is called for
 * each one; one that throws does not stop the others.
 */
export function createLaunchFileQueue(
  open: (file: string) => void,
  onError: (error: unknown) => void = () => {},
): LaunchFileQueue {
  let isReady = false;
  const held: string[] = [];

  function hand(file: string): void {
    try {
      open(file);
    } catch (error) {
      onError(error);
    }
  }

  return {
    add(file) {
      if (isReady) {
        hand(file);
      } else {
        held.push(file);
      }
    },

    ready() {
      if (isReady) {
        return;
      }
      isReady = true;
      for (const file of held.splice(0)) {
        hand(file);
      }
    },
  };
}
