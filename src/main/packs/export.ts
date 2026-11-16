/**
 * main/packs (Story 3.3's second half): writes an installed pack as a
 * `.awpet` at the place the user picked.
 *
 * 1. The pack is looked up in the store (`not-installed` when it is not, for
 *    example removed while the save dialog was open). Every file of its
 *    folder (`packs/<packId>/<version>/`) is listed, folders followed, and
 *    read into memory at once, synchronously: once read, removing or
 *    replacing the pack changes nothing of this export. Anything that is
 *    neither a regular file nor a folder (a symbolic link, say), a folder
 *    that is missing or cannot be read, or one with no file at all, is
 *    `read-failed`.
 * 2. The zip (yazl) holds one root folder `<packId>/` with every file under
 *    its path in the installed folder, sorted by path, its bytes unchanged:
 *    what inspectPack takes back. Nothing else goes in: no setting, no
 *    override, no path on the user's disk. Every entry has the same time
 *    (exportMtime, stored as a DOS date and time only) and mode, so one pack
 *    exports to the same bytes on any machine, in any time zone. A file
 *    yazl cannot take (a name it refuses, a file over its size limit;
 *    neither can come from an install) is `read-failed` too.
 * 3. The zip is written to a temporary file next to the target
 *    (`.awpet-export-<token>.tmp`, created only if no file of that name is
 *    there), flushed to disk (fsync), then renamed over the target (the save
 *    dialog has asked before replacing a file). A failure removes the
 *    temporary file and is `write-failed`; the target is as it was.
 *
 * Never throws or rejects. Log lines carry codes, counts and the pack id
 * only, never the place picked.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import { ZipFile } from 'yazl';
import type { PackExportFailureCode } from '../../shared/packs';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import { PACK_FILE_EXTENSION } from './launch-files';
import type { PacksStore } from './store';

/**
 * The time every exported entry carries: 2000-01-01 00:00 as a DOS date and
 * time, whatever the time zone. yazl reads a Date's local fields, so it is
 * built anew, in local time, for each export (the zone may have changed
 * since the last one); forceDosTimestamp leaves out the extra field that
 * would hold it as UTC seconds.
 */
export function exportMtime(): Date {
  return new Date(2000, 0, 1);
}

/** The mode every exported file carries: a regular file, rw-r--r--. */
export const EXPORT_FILE_MODE = 0o100644;

/** How many temporary names are tried when one is taken. */
const TEMP_NAME_ATTEMPTS = 3;

/** The save dialog's file name to start with: `<packId>-<version>.awpet`. */
export function exportFileName(packId: string, version: string): string {
  return `${packId}-${version}${PACK_FILE_EXTENSION}`;
}

/** The name of a temporary file in the target's folder. */
export function exportTempName(token: string): string {
  return `.awpet-export-${token}.tmp`;
}

/** What the listing needs of a directory entry. */
export interface PackExportDirEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The parts of node:fs an export uses; tests inject failures. */
export interface PackExportFs {
  readdirSync(
    dir: string,
    options: { withFileTypes: true },
  ): PackExportDirEntry[];
  readFileSync(file: string): Buffer;
  writeFileSync(
    file: string,
    data: Uint8Array,
    options: { readonly flag: 'wx'; readonly flush: true },
  ): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export interface PackExportOptions {
  readonly fs?: PackExportFs;
  /** Names the temporary file; tests make it predictable. */
  readonly token?: () => string;
}

/** The exported pack's name and version, or why nothing was written. */
export type PackExportResult =
  | { readonly ok: true; readonly name: string; readonly version: string }
  | { readonly ok: false; readonly code: PackExportFailureCode };

/** Thrown while listing: something that is neither a file nor a folder. */
class NotAFile extends Error {
  readonly code = 'not-a-file';
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('packs', message, level);
}

function compareNames(
  [a]: readonly [string, Buffer],
  [b]: readonly [string, Buffer],
): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every file under `root`, by its `/`-separated path inside it, read into
 * memory and sorted by path. Throws what failed.
 */
function readFiles(
  fs: PackExportFs,
  root: string,
): readonly (readonly [string, Buffer])[] {
  const files: (readonly [string, Buffer])[] = [];
  function walk(dir: string, prefix: string): void {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, item.name);
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) {
        walk(at, `${name}/`);
      } else if (item.isFile()) {
        files.push([name, fs.readFileSync(at)]);
      } else {
        throw new NotAFile();
      }
    }
  }
  walk(root, '');
  return files.sort(compareNames);
}

/** The zip of `files` under the root folder `packId` (see the module comment). */
async function zipOf(
  packId: string,
  files: readonly (readonly [string, Buffer])[],
): Promise<Buffer> {
  const zip = new ZipFile();
  const mtime = exportMtime();
  for (const [name, data] of files) {
    zip.addBuffer(data, `${packId}/${name}`, {
      mtime,
      mode: EXPORT_FILE_MODE,
      forceDosTimestamp: true,
    });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Exports the installed pack `packId` of `store` to `target` (see the module
 * comment) and answers its name and version, or why nothing was written.
 */
export async function exportPack(
  store: Pick<PacksStore, 'dir' | 'find'>,
  packId: string,
  target: string,
  { fs = nodeFs, token = randomUUID }: PackExportOptions = {},
): Promise<PackExportResult> {
  function fail(
    code: PackExportFailureCode,
    cause?: unknown,
  ): PackExportResult {
    const why = cause === undefined ? '' : ` (${errorCode(cause)})`;
    log(
      `could not export pack ${packId}: ${code}${why}`,
      code === 'not-installed' ? 'warn' : 'error',
    );
    return { ok: false, code };
  }
  /** Removes the temporary file `temp`; a failure is only logged. */
  function removeTemp(temp: string): void {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        log(
          `could not remove pack ${packId}'s temporary export file (${errorCode(error)})`,
          'error',
        );
      }
    }
  }

  const entry = store.find(packId);
  if (entry === undefined) {
    return fail('not-installed');
  }
  let files: readonly (readonly [string, Buffer])[];
  try {
    files = readFiles(fs, path.join(store.dir, entry.id, entry.version));
  } catch (error) {
    return fail('read-failed', error);
  }
  if (files.length === 0) {
    return fail('read-failed');
  }

  let data: Buffer;
  try {
    data = await zipOf(entry.id, files);
  } catch (error) {
    return fail('read-failed', error);
  }

  const dir = path.dirname(target);
  for (let attempt = 1; ; attempt += 1) {
    const temp = path.join(dir, exportTempName(token()));
    try {
      fs.writeFileSync(temp, data, { flag: 'wx', flush: true });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        // Someone else's file: never touched, another name is tried.
        if (attempt < TEMP_NAME_ATTEMPTS) {
          continue;
        }
      } else {
        // It may have been created before the write failed.
        removeTemp(temp);
      }
      return fail('write-failed', error);
    }
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      removeTemp(temp);
      return fail('write-failed', error);
    }
    break;
  }
  log(`exported pack ${packId} (${files.length} files)`);
  return { ok: true, name: entry.name, version: entry.version };
}
