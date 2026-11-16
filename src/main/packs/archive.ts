/**
 * main/packs: reading a `.awpet` (a zip) with yauzl, and the checks that
 * need only the zip itself (Story 3.2). In order:
 *
 * 1. The number of entries the zip says it has (folders included) is at
 *    most PACK_IMPORT_MAX_ENTRIES, before any entry is read.
 * 2. Every entry of the central directory, before any file is read: its
 *    name (file or folder) is at most PACK_IMPORT_MAX_PATH_LENGTH long with
 *    at most PACK_IMPORT_MAX_PATH_SEGMENTS segments, and is a pack path
 *    (packPathSchema: each segment only `A-Z a-z 0-9 . _ -`, not empty, not
 *    ending in `.`, not a Windows device name). ASCII only, so no two
 *    spellings can be one file on a file system that folds case or
 *    Unicode (`entry.jſ` is `entry.js` on APFS). It is not a symbolic link
 *    or a `.lnk` file, and the files so far stay within
 *    PACK_IMPORT_MAX_FILES and, by the sizes they declare,
 *    PACK_IMPORT_MAX_TOTAL_BYTES. An entry that cannot be unpacked
 *    (encrypted, an unknown compression) makes the zip invalid.
 * 3. No two entries (with the folders their names imply) differ only in
 *    case, and no file shares a name with a folder.
 * 4. The root holds exactly one folder and nothing else.
 * 5. Each file is unpacked into memory, counting its bytes as they come: a
 *    file that turns out longer than it declared stops right there, so
 *    nothing beyond the limits is ever held.
 *
 * yauzl's own name checks and size checks are turned off (decodeStrings and
 * validateEntrySizes), so each problem gets its own rejection code instead
 * of one error. A name quoted in a rejection is cut to
 * PACK_REJECTED_NAME_MAX_LENGTH and its control and bidi characters are
 * escaped, since the display layer shows it. Nothing here logs: inspect.ts
 * does.
 */
import { Buffer } from 'node:buffer';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import {
  PACK_IMPORT_MAX_ENTRIES,
  PACK_IMPORT_MAX_FILES,
  PACK_IMPORT_MAX_PATH_LENGTH,
  PACK_IMPORT_MAX_PATH_SEGMENTS,
  PACK_IMPORT_MAX_TOTAL_BYTES,
  PACK_REJECTED_NAME_MAX_LENGTH,
} from '../../shared/constants';
import { packPathSchema } from '../../shared/pack-api';
import type { PackRejection } from '../../shared/packs';

/** A zip read without a problem: its root folder and its files. */
export interface PackArchive {
  /** The one folder at the zip's root. */
  readonly root: string;
  /** Each file's bytes, by its path inside the root folder (`/`-separated). */
  readonly files: ReadonlyMap<string, Buffer>;
}

export type PackArchiveResult =
  | ({ readonly ok: true } & PackArchive)
  | { readonly ok: false; readonly rejection: PackRejection };

/** Thrown while reading to refuse the pack; readPackArchive answers it. */
class Refused extends Error {
  constructor(readonly rejection: PackRejection) {
    super(rejection.code);
  }
}

/** One entry of the central directory, its name decoded and checked. */
interface ListedEntry {
  readonly entry: Entry;
  /** Without a folder's trailing `/`. */
  readonly name: string;
  readonly folder: boolean;
}

/** File type bits of a Unix mode, and the value for a symbolic link. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Whether an entry name (a folder's without its `/`) may be unpacked. */
function isSafeName(name: string): boolean {
  return (
    name.length <= PACK_IMPORT_MAX_PATH_LENGTH &&
    name.split('/').length <= PACK_IMPORT_MAX_PATH_SEGMENTS &&
    packPathSchema.safeParse(name).success
  );
}

/**
 * C0 and C1 controls, DEL, the line and paragraph separators, and the bidi
 * embedding, override and isolate characters, which could make a quoted
 * name read as something else.
 */
function needsEscape(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * `name` as a rejection may quote it: control and bidi characters as
 * `\uXXXX`, cut at PACK_REJECTED_NAME_MAX_LENGTH characters (between
 * characters, never inside an escape) and then ending with `…`.
 */
export function quotedName(name: string): string {
  let out = '';
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    const piece = needsEscape(code)
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : char;
    if (out.length + piece.length > PACK_REJECTED_NAME_MAX_LENGTH) {
      return `${out}…`;
    }
    out += piece;
  }
  return out;
}

/** Made by a Unix zip tool with the symbolic link file type. */
function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;
}

/**
 * Lists the central directory (steps 1 and 2). The names are decoded as
 * the zip says (UTF-8 or CP437, or the Info-ZIP Unicode path field),
 * keeping any `\` so it can be refused.
 */
async function listEntries(zip: ZipFile): Promise<ListedEntry[]> {
  if (zip.entryCount > PACK_IMPORT_MAX_ENTRIES) {
    throw new Refused({ code: 'too-large', limit: 'entry-count' });
  }
  const listed: ListedEntry[] = [];
  let files = 0;
  let declaredBytes = 0;
  for await (const entry of zip.eachEntry()) {
    const raw = yauzl.getFileNameLowLevel(
      entry.generalPurposeBitFlag,
      entry.fileNameRaw,
      entry.extraFields,
      true,
    );
    const folder = raw.endsWith('/');
    const name = folder ? raw.slice(0, -1) : raw;
    if (!isSafeName(name)) {
      throw new Refused({ code: 'unsafe-path', path: quotedName(raw) });
    }
    if (isSymlink(entry) || (!folder && name.toLowerCase().endsWith('.lnk'))) {
      throw new Refused({ code: 'shortcut', path: quotedName(raw) });
    }
    if (!folder) {
      files += 1;
      declaredBytes += entry.uncompressedSize;
      if (files > PACK_IMPORT_MAX_FILES) {
        throw new Refused({ code: 'too-large', limit: 'file-count' });
      }
      if (declaredBytes > PACK_IMPORT_MAX_TOTAL_BYTES) {
        throw new Refused({ code: 'too-large', limit: 'total-size' });
      }
      if (!entry.canDecodeFileData()) {
        throw new Refused({ code: 'invalid-archive' });
      }
    }
    listed.push({ entry, name, folder });
  }
  return listed;
}

/**
 * The first name (a file, or a folder an entry implies) that clashes with
 * an earlier one (step 3): the same name again for a file, a spelling that
 * differs only in case, or a file and a folder of one name. Names are
 * ASCII by now, so lower case is all the folding there is.
 */
function findNameConflict(listed: readonly ListedEntry[]): string | undefined {
  const seen = new Map<string, { spelling: string; folder: boolean }>();
  for (const { name, folder } of listed) {
    const segments = name.split('/');
    let spelling = '';
    for (let depth = 1; depth <= segments.length; depth += 1) {
      spelling =
        depth === 1
          ? (segments[0] ?? '')
          : `${spelling}/${segments[depth - 1]}`;
      const isFolder = depth < segments.length || folder;
      const key = spelling.toLowerCase();
      const known = seen.get(key);
      if (known === undefined) {
        seen.set(key, { spelling, folder: isFolder });
      } else if (!isFolder || !known.folder || known.spelling !== spelling) {
        return spelling;
      }
    }
  }
  return undefined;
}

/** The root's one folder, or undefined when there is not exactly one (step 4). */
function rootFolder(listed: readonly ListedEntry[]): string | undefined {
  const roots = new Set(listed.map(({ name }) => name.split('/')[0]));
  const fileAtRoot = listed.some(
    ({ name, folder }) => !folder && !name.includes('/'),
  );
  if (roots.size !== 1 || fileAtRoot) {
    return undefined;
  }
  return [...roots][0];
}

/**
 * One file's bytes (step 5). More bytes than it declared stops the read
 * (`too-large`); a file system error while reading is `unreadable-file`;
 * fewer bytes, or anything else yauzl or zlib reports, means the zip is
 * damaged.
 */
async function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  const declared = entry.uncompressedSize;
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    const stream = await zip.openReadStreamPromise(entry);
    // Leaving the loop early destroys the stream.
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      length += bytes.length;
      if (length > declared) {
        throw new Refused({ code: 'too-large', limit: 'declared-size' });
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof Refused) {
      throw error;
    }
    throw new Refused(rejectionFor(error));
  }
  if (length < declared) {
    throw new Refused({ code: 'invalid-archive' });
  }
  return Buffer.concat(chunks, length);
}

/**
 * A failure that is not a Refused: a file system error (it names the
 * system call that failed: ENOENT, EACCES, EISDIR, EIO… while opening or
 * reading) is `unreadable-file`; anything else, yauzl or zlib finding
 * something it cannot read (zlib errors have an errno too, but no system
 * call) or a Node `ERR_…` error, is `invalid-archive`.
 */
export function rejectionFor(error: unknown): PackRejection {
  const syscall =
    typeof error === 'object' && error !== null
      ? (error as { syscall?: unknown }).syscall
      : undefined;
  return typeof syscall === 'string' && syscall !== ''
    ? { code: 'unreadable-file' }
    : { code: 'invalid-archive' };
}

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: false,
        validateEntrySizes: false,
      },
      (error, zip) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(zip);
        }
      },
    );
  });
}

/**
 * Reads the `.awpet` at `file`: its root folder and every file in it, or
 * the first reason to refuse it. Never throws.
 */
export async function readPackArchive(
  file: string,
): Promise<PackArchiveResult> {
  let zip: ZipFile;
  try {
    zip = await openZip(file);
  } catch (error) {
    return { ok: false, rejection: rejectionFor(error) };
  }
  // Errors reach the code below through the entry iterator and the read
  // streams; one that comes later (closing the file) must not go unheard,
  // which would throw.
  zip.on('error', () => {});
  try {
    const listed = await listEntries(zip);
    const conflict = findNameConflict(listed);
    if (conflict !== undefined) {
      return {
        ok: false,
        rejection: { code: 'name-conflict', path: quotedName(conflict) },
      };
    }
    const root = rootFolder(listed);
    if (root === undefined) {
      return { ok: false, rejection: { code: 'invalid-root' } };
    }
    const files = new Map<string, Buffer>();
    for (const { entry, name, folder } of listed) {
      if (!folder) {
        files.set(name.slice(root.length + 1), await readEntry(zip, entry));
      }
    }
    return { ok: true, root, files };
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, rejection: error.rejection };
    }
    return { ok: false, rejection: rejectionFor(error) };
  } finally {
    zip.close();
  }
}
