/**
 * main/detection/adapters/cursor/project-name: a Cursor session's display
 * name, from its project folder's name under `~/.cursor/projects`, the slug
 * (Story 2.7). Cursor names that folder after the project's path, every
 * character that is not a letter or a digit turned into `-`:
 * `/Users/me/gundam-pet` is `Users-me-gundam-pet`.
 *
 * Read back, each `-` may have been `/`, `-`, `_`, `.` or a space. The
 * search goes folder by folder, from the root: a folder's name is tried
 * as the next 1, 2, 3, ... parts of the slug (its tokens), with every mix
 * of `-`, `_`, `.` and spaces between them (in that order), and a name
 * whose stat shows a folder is gone into at once (depth first: of two
 * folders that both fit, the deeper one is found). Once every token is
 * used and the path is a folder, that is the project's folder; its last
 * part (`gundam-pet`) names the session. At most PROJECT_NAME_MAX_STATS
 * stats are taken per slug; when none is found within them, the slug
 * itself is the name. Each slug's answer is kept: it is worked out once
 * per adapter run.
 *
 * A folder name of k tokens costs up to 4^(k-1) stats of its own, and
 * every shorter try before it: a folder name of 7 or more tokens (6
 * separators) is out of reach, its project named after the slug.
 *
 * On Windows the slug is taken to start with the drive letter
 * (`C:\Users\me\x` as `C--Users-me-x`); that form is a guess, not seen in
 * real folders. Nothing is opened, listed or read: only `stat` is called,
 * and it is injected (tests hand in a fake).
 */
import path from 'node:path';
import { displayNameOf, folderNameOf } from '../jsonl/records';

/**
 * What `-` in a slug may have been within a folder's name, in the order
 * they are tried (or `/`, between folders).
 */
export const NAME_SEPARATORS = ['-', '_', '.', ' '] as const;

/** At most this many stats are taken to read one slug back. */
export const PROJECT_NAME_MAX_STATS = 512;

/** A file's stats, as far as the search needs them; throws when it is not there. */
export type StatPath = (file: string) => { isDirectory(): boolean };

/**
 * The folder slug `slug` was made from, found by stats with `stat` (see
 * the module comment); null when none is found within
 * PROJECT_NAME_MAX_STATS stats. `platform` picks the path rules.
 */
export function findProjectFolder(
  slug: string,
  stat: StatPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let tokens = slug.split('-');
  let base: string = paths.sep;
  const [drive = ''] = tokens;
  if (platform === 'win32' && /^[A-Za-z]$/.test(drive)) {
    base = `${drive.toUpperCase()}:\\`;
    tokens = tokens.slice(1);
  }
  // A leading separator (`/`, or `:\` after a drive) left empty tokens.
  while (tokens[0] === '') {
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) {
    return null;
  }

  let stats = 0;
  /** Whether `file` is a folder; false once the stats are used up. */
  const isFolder = (file: string): boolean => {
    if (stats >= PROJECT_NAME_MAX_STATS) {
      return false;
    }
    stats += 1;
    try {
      return stat(file).isDirectory();
    } catch {
      return false;
    }
  };

  /**
   * The project's folder below folder `dir`, made of the tokens from
   * `index` on; null when there is none (or the stats are used up).
   */
  const search = (dir: string, index: number): string | null => {
    for (let end = index + 1; end <= tokens.length; end += 1) {
      for (const name of namesOf(tokens.slice(index, end))) {
        if (stats >= PROJECT_NAME_MAX_STATS) {
          return null;
        }
        if (name === '') {
          continue;
        }
        const folder = paths.join(dir, name);
        if (!isFolder(folder)) {
          continue;
        }
        const found = end === tokens.length ? folder : search(folder, end);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };

  return search(base, 0);
}

/**
 * Every folder name `parts` (tokens) can make, one of NAME_SEPARATORS
 * between each two, in order: all `-` first. Lazy, so a search that stops
 * makes no more.
 */
function* namesOf(parts: readonly string[]): Generator<string> {
  const [first = '', ...rest] = parts;
  if (rest.length === 0) {
    yield first;
    return;
  }
  for (const separator of NAME_SEPARATORS) {
    for (const tail of namesOf(rest)) {
      yield `${first}${separator}${tail}`;
    }
  }
}

/**
 * Display names by slug, worked out with `stat` once per slug: the found
 * folder's name, else the slug; null for a slug that cannot be a name.
 */
export function createProjectNames(
  stat: StatPath,
  platform: NodeJS.Platform = process.platform,
): (slug: string) => string | null {
  const names = new Map<string, string | null>();
  return (slug) => {
    if (names.has(slug)) {
      return names.get(slug) ?? null;
    }
    const folder = findProjectFolder(slug, stat, platform);
    const name =
      (folder === null ? null : folderNameOf(folder)) ?? displayNameOf(slug);
    names.set(slug, name);
    return name;
  };
}
