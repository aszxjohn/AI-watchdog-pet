/**
 * Builds `.awpet` files for the main/packs tests: the contract test pack
 * (test/packs/contract-pack/) zipped with yazl, or a copy of it with files
 * changed, added or removed. yazl refuses some of the names the import must
 * refuse (`..`, a leading `/`, `\`), so patchName rewrites a name in the
 * finished zip, byte for byte, in both places a zip stores it.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

/** The unpacked contract pack: one `contract-pack/` folder. */
const CONTRACT_PACK_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packs',
  'contract-pack',
  'contract-pack',
);

/** The contract pack's id, which is also its folder's name. */
export const CONTRACT_PACK_ID = 'contract-pack';

/** One entry to zip. */
export interface ZipItem {
  /** The name in the zip; a folder's ends with `/`. */
  readonly name: string;
  readonly data?: Buffer | string;
  /** Unix mode bits (a symbolic link: 0o120777). */
  readonly mode?: number;
  /** false stores the file instead of deflating it. */
  readonly compress?: boolean;
}

/** A fixed time, so two builds of one list are the same bytes. */
const MTIME = new Date(2026, 10, 16, 9, 0, 0);

/** The zip of `items`, in their order. */
export async function zipBuffer(items: readonly ZipItem[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const item of items) {
    if (item.name.endsWith('/')) {
      zip.addEmptyDirectory(item.name, { mtime: MTIME });
      continue;
    }
    const data =
      typeof item.data === 'string'
        ? Buffer.from(item.data, 'utf8')
        : (item.data ?? Buffer.alloc(0));
    zip.addBuffer(data, item.name, {
      mtime: MTIME,
      ...(item.mode === undefined ? {} : { mode: item.mode }),
      ...(item.compress === undefined ? {} : { compress: item.compress }),
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
 * The contract pack's files, by path inside its folder (`/`-separated),
 * Finder's `.DS_Store` left out.
 */
export function contractPackFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const names = fs
    .readdirSync(CONTRACT_PACK_DIR, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .filter((name) => path.posix.basename(name) !== '.DS_Store')
    .sort();
  for (const name of names) {
    const file = path.join(CONTRACT_PACK_DIR, name);
    if (fs.statSync(file).isFile()) {
      files.set(name, fs.readFileSync(file));
    }
  }
  return files;
}

/** The contract pack's manifest, parsed (a fresh copy each call). */
export function contractManifest(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(CONTRACT_PACK_DIR, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}

/** Zip items for `files` under the root folder `root`. */
export function itemsOf(
  files: ReadonlyMap<string, Buffer | string>,
  root = CONTRACT_PACK_ID,
): ZipItem[] {
  return [...files].map(([name, data]) => ({ name: `${root}/${name}`, data }));
}

/** `manifest` as manifest.json's bytes. */
export function manifestBytes(manifest: unknown): Buffer {
  return Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * `zip` with every `from` name replaced by `to` (as UTF-8, of the same
 * length): a zip stores a name in its local header and again in the
 * central directory, and both must change.
 */
export function patchName(zip: Buffer, from: string, to: string): Buffer {
  const before = Buffer.from(from, 'utf8');
  const after = Buffer.from(to, 'utf8');
  if (before.length !== after.length) {
    throw new Error('patchName keeps the length of a name');
  }
  const out = Buffer.from(zip);
  let count = 0;
  for (
    let at = out.indexOf(before);
    at >= 0;
    at = out.indexOf(before, at + 1)
  ) {
    after.copy(out, at);
    count += 1;
  }
  if (count < 2) {
    throw new Error(`patchName found ${from} ${count} times`);
  }
  return out;
}

/**
 * `zip` with the uncompressed size the central directory gives for `name`
 * set to `size`, as a zip that lies about a file's size would have it.
 */
export function patchDeclaredSize(
  zip: Buffer,
  name: string,
  size: number,
): Buffer {
  const out = Buffer.from(zip);
  const wanted = Buffer.from(name, 'utf8');
  for (let at = 0; at + 46 <= out.length; at += 1) {
    if (out.readUInt32LE(at) !== 0x02014b50) {
      continue;
    }
    const nameLength = out.readUInt16LE(at + 28);
    if (out.subarray(at + 46, at + 46 + nameLength).equals(wanted)) {
      out.writeUInt32LE(size, at + 24);
      return out;
    }
  }
  throw new Error(`no central directory entry for ${name}`);
}

/** The bytes of a PNG chunk: length, type, data, CRC (not checked here). */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([
    length,
    Buffer.from(type, 'latin1'),
    data,
    Buffer.alloc(4),
  ]);
}

/**
 * The start of a PNG `width` × `height` pixels: the signature and the
 * IHDR chunk, all the import reads of an image.
 */
export function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]);
}
