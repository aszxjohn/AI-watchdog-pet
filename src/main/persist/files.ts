/**
 * main/persist: the file handling main/settings and main/pool share for the
 * small JSON files each of them owns (settings.json, assignments.json).
 *
 * - writeFileAtomic: a temp file next to the target, fsync'ed, then renamed
 *   over it, so a crash or power loss leaves either the old file or the new
 *   one, never a half-written one. On failure the temp file is removed and
 *   the error is thrown for the owner to log.
 * - Broken files: brokenBackupPath names a free
 *   `<file>.broken-<YYYYMMDD-HHmmss>[-N]` next to the file, and
 *   renameBroken moves the file there.
 *
 * Nothing here logs: the owner knows what the file is and words the log
 * line (file names and error codes only, never contents). Writing what an
 * owner still holds back when the app quits is in main/persist/quit.
 */
import path from 'node:path';
import { localSecondStamp } from '../log/local-time';

/** The parts of node:fs writeFileAtomic uses. */
export interface AtomicWriteFs {
  writeFileSync(
    file: string,
    data: string,
    options: { encoding: 'utf8'; flush: true },
  ): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
}

/** The parts of node:fs the broken-file helpers use. */
export interface BrokenFileFs {
  existsSync(file: string): boolean;
  renameSync(from: string, to: string): void;
}

/** Up to how many `-N` suffixes are tried when backup names collide. */
const MAX_BACKUP_SUFFIX = 999;

/**
 * Writes `text` to `file` through `<file>.tmp` (created with its folder if
 * needed, fsync'ed before the rename). Throws what failed, after removing
 * the temp file.
 */
export function writeFileAtomic(
  fs: AtomicWriteFs,
  file: string,
  text: string,
): void {
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // flush: fsync the temp file before the rename, so a power loss
    // cannot leave an empty file behind.
    fs.writeFileSync(temp, text, { encoding: 'utf8', flush: true });
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp file may never have been created.
    }
    throw error;
  }
}

/**
 * A free `<file>.broken-<local time of nowMs>[-N]` path. Throws when there
 * is none.
 */
export function brokenBackupPath(
  fs: Pick<BrokenFileFs, 'existsSync'>,
  file: string,
  nowMs: number,
): string {
  const base = `${file}.broken-${localSecondStamp(new Date(nowMs))}`;
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

/**
 * Moves an unusable `file` to a free brokenBackupPath and answers that
 * path. Throws when no name is free or the rename fails.
 */
export function renameBroken(
  fs: BrokenFileFs,
  file: string,
  nowMs: number,
): string {
  const target = brokenBackupPath(fs, file, nowMs);
  fs.renameSync(file, target);
  return target;
}
