/**
 * main/packs export (Story 3.3's second half): the contract test pack
 * installed (inspectPack and installPack, as an import does) into a packs
 * folder in a temp folder, then exported with exportPack and read back:
 * with yauzl entry by entry, and with the real inspectPack (and
 * installPack) as a new import would. Failures come from a missing or
 * changed installed folder, a target the export cannot write, or an
 * injected fs.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import {
  EXPORT_FILE_MODE,
  exportFileName,
  exportMtime,
  exportPack,
  exportTempName,
  type PackExportFs,
} from '../../src/main/packs/export';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { removePack } from '../../src/main/packs/remove';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import {
  CONTRACT_PACK_ID,
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let root: string;
let dir: string;
let out: string;
let tokens: number;

beforeEach(() => {
  fake.resetFakeElectron();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-export-'));
  dir = path.join(root, 'packs');
  out = path.join(root, 'out');
  fs.mkdirSync(out);
  tokens = 0;
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function packsLines(level: 'info' | 'warn' | 'error'): string[] {
  return vi
    .mocked(console[level])
    .mock.calls.map((call: unknown[]) => String(call[0]))
    .filter((line) => line.startsWith('[packs] '));
}

/** Predictable temporary file names: .awpet-export-t1.tmp, … */
function token(): string {
  tokens += 1;
  return `t${tokens}`;
}

/** The contract pack's files at `version`, with `extra` files added. */
function packFiles(
  version: string,
  extra: Record<string, string>,
): Map<string, Buffer> {
  const files = contractPackFiles();
  const manifest = contractManifest();
  manifest.version = version;
  files.set('manifest.json', manifestBytes(manifest));
  for (const [name, data] of Object.entries(extra)) {
    files.set(name, Buffer.from(data, 'utf8'));
  }
  return files;
}

/**
 * A packs folder with the contract pack installed at `version` (with
 * `extra` files), as an import installs it. Answers the store and the
 * files installed.
 */
async function installed(
  version = '1.0.0',
  extra: Record<string, string> = {},
): Promise<{ store: PacksStore; files: Map<string, Buffer> }> {
  const store = loadPacks({ dir });
  const files = packFiles(version, extra);
  const awpet = path.join(root, `source-${version}.awpet`);
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
  const inspection = await inspectPack(awpet, store);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  const result = installPack(store, inspection.plan);
  if (!result.ok) {
    throw new Error(result.code);
  }
  return { store, files };
}

/** The installed folder of the contract pack at `version`. */
function installedFolder(version = '1.0.0'): string {
  return path.join(dir, CONTRACT_PACK_ID, version);
}

/** Node's fs as an export uses it, with `over` in place. */
function fsWith(over: Partial<PackExportFs> = {}): PackExportFs {
  return {
    readdirSync: (at, options) => fs.readdirSync(at, options),
    readFileSync: (file) => fs.readFileSync(file),
    writeFileSync: (file, data, options) => {
      fs.writeFileSync(file, data, options);
    },
    renameSync: (from, to) => {
      fs.renameSync(from, to);
    },
    unlinkSync: (file) => {
      fs.unlinkSync(file);
    },
    ...over,
  };
}

function exportTo(
  store: PacksStore,
  target: string,
  fsImpl?: PackExportFs,
  packId = CONTRACT_PACK_ID,
) {
  return exportPack(store, packId, target, {
    token,
    ...(fsImpl === undefined ? {} : { fs: fsImpl }),
  });
}

/** What is in the target's folder, sorted. */
function outFiles(): string[] {
  return fs.readdirSync(out).sort();
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly dosDate: number;
  readonly dosTime: number;
  readonly mode: number;
  readonly extraFields: number;
}

/** Every entry of the zip `data`, in the zip's order, with its bytes. */
async function zipEntries(data: Buffer): Promise<ZipEntry[]> {
  const zip = await yauzl.fromBufferPromise(data, {
    lazyEntries: true,
    autoClose: false,
  });
  const listed: yauzl.Entry[] = [];
  for await (const entry of zip.eachEntry()) {
    listed.push(entry);
  }
  const entries: ZipEntry[] = [];
  for (const entry of listed) {
    const chunks: Buffer[] = [];
    for await (const chunk of await zip.openReadStreamPromise(entry)) {
      chunks.push(chunk as Buffer);
    }
    entries.push({
      name: entry.fileName,
      data: Buffer.concat(chunks),
      dosDate: entry.lastModFileDate,
      dosTime: entry.lastModFileTime,
      mode: entry.externalFileAttributes >>> 16,
      extraFields: entry.extraFields.length,
    });
  }
  zip.close();
  return entries;
}

/** 2000-01-01 as a DOS date: (year - 1980) << 9 | month << 5 | day. */
const DOS_DATE_2000_01_01 = (20 << 9) | (1 << 5) | 1;

describe('the names', () => {
  it('the save dialog starts with <packId>-<version>.awpet', () => {
    expect(exportFileName('sample-pack', '1.2.0')).toBe(
      'sample-pack-1.2.0.awpet',
    );
    expect(exportFileName('sample-pack', '1.0.0-beta.1')).toBe(
      'sample-pack-1.0.0-beta.1.awpet',
    );
  });

  it('the temporary file is a hidden .tmp name of its own, whatever the target is called', () => {
    expect(exportTempName('t1')).toBe('.awpet-export-t1.tmp');
  });

  it('every entry is dated 2000-01-01 00:00 local time, built anew each time', () => {
    const first = exportMtime();
    expect(first).toStrictEqual(new Date(2000, 0, 1));
    expect(exportMtime()).not.toBe(first);
    expect(EXPORT_FILE_MODE).toBe(0o100644);
  });
});

describe('I/O matrix', () => {
  it('匯出完成: the zip has one root folder <packId>/ holding every installed file, bytes unchanged, sorted by path, and nothing else', async () => {
    const { store, files } = await installed('1.0.0', {
      'notes/b.txt': 'b',
      'notes/a/deep.txt': 'deep',
    });
    const target = path.join(out, 'exported.awpet');

    expect(await exportTo(store, target)).toStrictEqual({
      ok: true,
      name: '契約測試包',
      version: '1.0.0',
    });

    const entries = await zipEntries(fs.readFileSync(target));
    const expected = [...files.keys()].sort();
    expect(entries.map((entry) => entry.name)).toStrictEqual(
      expected.map((name) => `${CONTRACT_PACK_ID}/${name}`),
    );
    for (const entry of entries) {
      const name = entry.name.slice(CONTRACT_PACK_ID.length + 1);
      expect(entry.data.equals(files.get(name) as Buffer), name).toBe(true);
      // Byte for byte what is installed, too.
      expect(
        entry.data.equals(
          fs.readFileSync(path.join(installedFolder(), ...name.split('/'))),
        ),
        name,
      ).toBe(true);
    }
    expect(outFiles()).toStrictEqual(['exported.awpet']);
    expect(packsLines('info')).toContain(
      `[packs] exported pack ${CONTRACT_PACK_ID} (${files.size} files)`,
    );
  });

  it('匯出完成: inspectPack takes the exported file back (the same pack, the same files); installing it into a new packs folder works', async () => {
    const { store, files } = await installed();
    const target = path.join(out, exportFileName(CONTRACT_PACK_ID, '1.0.0'));
    await exportTo(store, target);

    // Imported again where it is installed: the same version, to replace.
    const again = await inspectPack(target, store);
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(again.plan.packId).toBe(CONTRACT_PACK_ID);
    expect(again.plan.version).toBe('1.0.0');
    expect(again.plan.previous).toStrictEqual({
      name: '契約測試包',
      version: '1.0.0',
    });
    expect(again.plan.index).toStrictEqual(store.find(CONTRACT_PACK_ID));
    expect([...again.plan.files.keys()].sort()).toStrictEqual(
      [...files.keys()].sort(),
    );
    for (const [name, data] of files) {
      expect(again.plan.files.get(name)?.equals(data), name).toBe(true);
    }

    // Imported on another machine: installed as a new pack.
    const elsewhere = loadPacks({ dir: path.join(root, 'elsewhere') });
    const fresh = await inspectPack(target, elsewhere);
    expect(fresh.ok && fresh.plan.previous).toBe(null);
    if (fresh.ok) {
      expect(installPack(elsewhere, fresh.plan)).toMatchObject({ ok: true });
    }
    expect(elsewhere.list()).toStrictEqual(store.list());
  });

  it('匯出完成: every entry carries the fixed time (a DOS date and time only, no UTC extra field) and mode 0o100644, so no local time goes in', async () => {
    const { store } = await installed();
    const target = path.join(out, 'exported.awpet');
    await exportTo(store, target);

    const entries = await zipEntries(fs.readFileSync(target));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        {
          date: entry.dosDate,
          time: entry.dosTime,
          mode: entry.mode,
          extraFields: entry.extraFields,
        },
        entry.name,
      ).toStrictEqual({
        date: DOS_DATE_2000_01_01,
        time: 0,
        mode: 0o100644,
        extraFields: 0,
      });
    }
  });

  it('匯出完成: two exports of one pack are the same bytes, in two time zones too', async () => {
    const { store } = await installed();
    const realTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      await exportTo(store, path.join(out, 'utc.awpet'));
      const utcOffset = new Date(2000, 0, 1).getTimezoneOffset();
      process.env.TZ = 'Asia/Tokyo';
      await exportTo(store, path.join(out, 'tokyo.awpet'));
      // The zone really changed in between.
      expect([utcOffset, new Date(2000, 0, 1).getTimezoneOffset()]).toEqual([
        0, -540,
      ]);
      await exportTo(store, path.join(out, 'again.awpet'));
    } finally {
      if (realTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = realTz;
      }
    }

    const utc = fs.readFileSync(path.join(out, 'utc.awpet'));
    expect(fs.readFileSync(path.join(out, 'tokyo.awpet')).equals(utc)).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(out, 'again.awpet')).equals(utc)).toBe(
      true,
    );
  });

  it('匯出完成: nothing of the user goes in: no setting next to the packs folder, no path on the disk', async () => {
    const { store, files } = await installed();
    fs.writeFileSync(
      path.join(root, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, packEnabled: { x: false } }),
    );
    const target = path.join(out, 'exported.awpet');
    await exportTo(store, target);

    const data = fs.readFileSync(target);
    expect((await zipEntries(data)).length).toBe(files.size);
    for (const word of [root, os.homedir(), 'settings.json', 'packEnabled']) {
      expect(data.includes(Buffer.from(word, 'utf8')), word).toBe(false);
    }
  });

  it('匯出完成: a file already at the target is replaced (the save dialog asked first)', async () => {
    const { store } = await installed();
    const target = path.join(out, 'exported.awpet');
    fs.writeFileSync(target, 'an older file');

    expect(await exportTo(store, target)).toMatchObject({ ok: true });

    expect(fs.readFileSync(target, 'utf8')).not.toBe('an older file');
    expect(outFiles()).toStrictEqual(['exported.awpet']);
  });

  it('讀不到: an installed folder that is gone is read-failed; nothing is written', async () => {
    const { store } = await installed();
    fs.rmSync(installedFolder(), { recursive: true, force: true });

    expect(
      await exportTo(store, path.join(out, 'exported.awpet')),
    ).toStrictEqual({ ok: false, code: 'read-failed' });
    expect(outFiles()).toStrictEqual([]);
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not export pack ${CONTRACT_PACK_ID}: read-failed (ENOENT)`,
    ]);
  });

  it('讀不到: a file that cannot be read is read-failed; nothing is written', async () => {
    const { store } = await installed();
    const fsImpl = fsWith({
      readFileSync: (file) => {
        if (file.endsWith('manifest.json')) {
          throw failure('EACCES');
        }
        return fs.readFileSync(file);
      },
    });

    expect(
      await exportTo(store, path.join(out, 'exported.awpet'), fsImpl),
    ).toStrictEqual({ ok: false, code: 'read-failed' });
    expect(outFiles()).toStrictEqual([]);
  });

  it('讀不到: something that is neither a file nor a folder (a symbolic link, say) is read-failed', async () => {
    const { store } = await installed();
    const fsImpl = fsWith({
      readdirSync: (at, options) => [
        ...fs.readdirSync(at, options),
        { name: 'link', isFile: () => false, isDirectory: () => false },
      ],
    });

    expect(
      await exportTo(store, path.join(out, 'exported.awpet'), fsImpl),
    ).toStrictEqual({ ok: false, code: 'read-failed' });
    expect(outFiles()).toStrictEqual([]);
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not export pack ${CONTRACT_PACK_ID}: read-failed (not-a-file)`,
    ]);
  });

  it('讀不到: an installed folder with no file left is read-failed', async () => {
    const { store } = await installed();
    for (const name of fs.readdirSync(installedFolder())) {
      fs.rmSync(path.join(installedFolder(), name), {
        recursive: true,
        force: true,
      });
    }

    expect(
      await exportTo(store, path.join(out, 'exported.awpet')),
    ).toStrictEqual({ ok: false, code: 'read-failed' });
    expect(outFiles()).toStrictEqual([]);
  });

  it('寫不進: a folder that does not exist is write-failed; nothing is written anywhere', async () => {
    const { store } = await installed();
    const before = fs.readdirSync(root).sort();

    expect(
      await exportTo(store, path.join(root, 'missing', 'exported.awpet')),
    ).toStrictEqual({ ok: false, code: 'write-failed' });
    expect(fs.readdirSync(root).sort()).toStrictEqual(before);
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not export pack ${CONTRACT_PACK_ID}: write-failed (ENOENT)`,
    ]);
  });

  it('寫不進: a write that fails partway (a full disk) leaves no temporary file next to the target', async () => {
    const { store } = await installed();
    const fsImpl = fsWith({
      writeFileSync: (file, data, options) => {
        fs.writeFileSync(file, data.subarray(0, 10), options);
        throw failure('ENOSPC');
      },
    });

    expect(
      await exportTo(store, path.join(out, 'exported.awpet'), fsImpl),
    ).toStrictEqual({ ok: false, code: 'write-failed' });
    expect(outFiles()).toStrictEqual([]);
  });

  it('寫不進: a rename that fails removes the temporary file and leaves the target as it was', async () => {
    const { store } = await installed();
    const target = path.join(out, 'exported.awpet');
    fs.writeFileSync(target, 'an older file');
    const fsImpl = fsWith({
      renameSync: () => {
        throw failure('EACCES');
      },
    });

    expect(await exportTo(store, target, fsImpl)).toStrictEqual({
      ok: false,
      code: 'write-failed',
    });
    expect(outFiles()).toStrictEqual(['exported.awpet']);
    expect(fs.readFileSync(target, 'utf8')).toBe('an older file');
  });

  it('寫不進: a folder at the target is write-failed, the folder untouched, no temporary file left', async () => {
    const { store } = await installed();
    const target = path.join(out, 'a-folder.awpet');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inside.txt'), 'kept');

    expect(await exportTo(store, target)).toStrictEqual({
      ok: false,
      code: 'write-failed',
    });
    expect(outFiles()).toStrictEqual(['a-folder.awpet']);
    expect(fs.readFileSync(path.join(target, 'inside.txt'), 'utf8')).toBe(
      'kept',
    );
  });

  it('寫不進: a temporary name already taken is never touched; the next one is tried', async () => {
    const { store } = await installed();
    const taken = path.join(out, exportTempName('t1'));
    fs.writeFileSync(taken, 'not ours');

    expect(
      await exportTo(store, path.join(out, 'exported.awpet')),
    ).toMatchObject({ ok: true });
    expect(fs.readFileSync(taken, 'utf8')).toBe('not ours');
    expect(outFiles()).toStrictEqual([exportTempName('t1'), 'exported.awpet']);
  });

  it('寫不進: when every name tried is taken, it is write-failed and none of them is touched', async () => {
    const { store } = await installed();
    for (const name of ['t1', 't2', 't3']) {
      fs.writeFileSync(path.join(out, exportTempName(name)), name);
    }

    expect(
      await exportTo(store, path.join(out, 'exported.awpet')),
    ).toStrictEqual({ ok: false, code: 'write-failed' });
    for (const name of ['t1', 't2', 't3']) {
      expect(
        fs.readFileSync(path.join(out, exportTempName(name)), 'utf8'),
      ).toBe(name);
    }
    expect(outFiles()).not.toContain('exported.awpet');
  });

  it('匯出時被移除: a pack that is not installed (any more) is not-installed; nothing is written', async () => {
    const { store } = await installed();
    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });

    expect(
      await exportTo(store, path.join(out, 'exported.awpet')),
    ).toStrictEqual({ ok: false, code: 'not-installed' });
    expect(outFiles()).toStrictEqual([]);
    expect(packsLines('warn')).toContain(
      `[packs] could not export pack ${CONTRACT_PACK_ID}: not-installed`,
    );
  });

  it('匯出時被移除: once the files are read, removing the pack changes nothing of the export', async () => {
    const { store, files } = await installed();
    const target = path.join(out, 'exported.awpet');

    const exporting = exportTo(store, target);
    // Right after exportPack read the files, before the zip is done.
    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID))).toBe(false);

    expect(await exporting).toMatchObject({ ok: true });
    const entries = await zipEntries(fs.readFileSync(target));
    expect(entries).toHaveLength(files.size);
  });

  it('logs codes, counts and the pack id only, never the place picked', async () => {
    const { store } = await installed();
    await exportTo(store, path.join(out, 'exported.awpet'));
    await exportTo(store, path.join(root, 'missing', 'exported.awpet'));
    await exportTo(
      store,
      path.join(out, 'other.awpet'),
      fsWith({
        renameSync: () => {
          throw failure('EPERM');
        },
      }),
    );

    const lines = [
      ...packsLines('info'),
      ...packsLines('warn'),
      ...packsLines('error'),
    ];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(root);
      expect(line).not.toContain('.awpet');
    }
  });
});
