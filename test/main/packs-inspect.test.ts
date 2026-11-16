/**
 * main/packs inspect (Story 3.2): every check a `.awpet` goes through
 * before it may be installed, on the contract test pack zipped with yazl
 * and on broken copies of it, in a temp folder. Nothing here installs.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { rejectionFor } from '../../src/main/packs/archive';
import {
  inspectPack,
  type InstalledPackLookup,
  type PackInspection,
} from '../../src/main/packs/inspect';
import {
  PACK_IMPORT_MAX_ENTRIES,
  PACK_IMPORT_MAX_FILES,
  PACK_IMPORT_MAX_IMAGE_SIDE,
  PACK_IMPORT_MAX_PATH_LENGTH,
  PACK_IMPORT_MAX_PATH_SEGMENTS,
  PACK_IMPORT_MAX_TOTAL_BYTES,
  PACK_IMPORT_MAX_TOTAL_PIXELS,
  PACK_REJECTED_NAME_MAX_LENGTH,
} from '../../src/shared/constants';
import type { PackRejection } from '../../src/shared/packs';
import {
  CONTRACT_PACK_ID,
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  patchDeclaredSize,
  patchName,
  pngHeader,
  zipBuffer,
  type ZipItem,
} from '../helpers/awpet';

const NOTHING_INSTALLED: InstalledPackLookup = { find: () => undefined };

/** The contract pack's served paths: entry, assets, the sheet's image. */
const CONTRACT_SERVED_PATHS = [
  'entry.js',
  'img/probe-one-dots.png',
  'img/probe-one-plain.png',
  'img/probe-two-sheet.json',
  'img/probe-two-sheet.png',
  'img/spark.png',
];

let dir: string;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-inspect-'));
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `zip` as a `.awpet` in the temp folder and answers its path. */
function writeAwpet(zip: Buffer, name = 'pack.awpet'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, zip);
  return file;
}

async function inspectZip(
  zip: Buffer,
  installed: InstalledPackLookup = NOTHING_INSTALLED,
): Promise<PackInspection> {
  return inspectPack(writeAwpet(zip), installed);
}

async function inspectItems(
  items: readonly ZipItem[],
  installed?: InstalledPackLookup,
): Promise<PackInspection> {
  return inspectZip(await zipBuffer(items), installed);
}

/** The contract pack with `change` applied to its files first. */
async function inspectChanged(
  change: (files: Map<string, Buffer | string>) => void,
  installed?: InstalledPackLookup,
): Promise<PackInspection> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  change(files);
  return inspectItems(itemsOf(files), installed);
}

/** The contract pack with its manifest changed by `change`. */
async function inspectWithManifest(
  change: (manifest: Record<string, unknown>) => void,
): Promise<PackInspection> {
  return inspectChanged((files) => {
    const manifest = contractManifest();
    change(manifest);
    files.set('manifest.json', manifestBytes(manifest));
  });
}

function rejectionOf(inspection: PackInspection): PackRejection {
  expect(inspection.ok, JSON.stringify(inspection)).toBe(false);
  if (inspection.ok) {
    throw new Error('not refused');
  }
  return inspection.rejection;
}

function planOf(inspection: PackInspection) {
  if (!inspection.ok) {
    throw new Error(`refused: ${JSON.stringify(inspection.rejection)}`);
  }
  return inspection.plan;
}

/** Every `[packs]` console line so far. */
function packsLines(): string[] {
  return info.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith('[packs] '));
}

/** The contract manifest's asset map, typed loosely for changes. */
function assetsOf(
  manifest: Record<string, unknown>,
): Record<string, { kind: string; path: string }> {
  return manifest.assets as Record<string, { kind: string; path: string }>;
}

describe('I/O matrix', () => {
  it('正常: the contract pack zipped is a plan: its id, version and name, no installed version', async () => {
    const plan = planOf(await inspectItems(itemsOf(contractPackFiles())));

    expect(plan.packId).toBe(CONTRACT_PACK_ID);
    expect(plan.version).toBe('1.0.0');
    expect(plan.name).toBe('契約測試包');
    expect(plan.previous).toBeNull();
    expect(plan.downgrade).toBe(false);
    expect(plan.index).toStrictEqual({
      id: CONTRACT_PACK_ID,
      name: '契約測試包',
      version: '1.0.0',
      apiVersion: '1.0',
      characters: [
        { id: 'probe-one', name: '探針一', height: 110 },
        { id: 'probe-two', name: '探針二', height: 96 },
      ],
      servedPaths: CONTRACT_SERVED_PATHS,
    });
    expect([...plan.files.keys()].sort()).toStrictEqual(
      [...contractPackFiles().keys()].sort(),
    );
    for (const [name, data] of contractPackFiles()) {
      expect(plan.files.get(name)?.equals(data), name).toBe(true);
    }
    expect(packsLines()).toStrictEqual([
      `[packs] checked pack ${CONTRACT_PACK_ID}: 7 files, ready to install`,
    ]);
  });

  it('正常: folder entries, stored files and extra files the manifest does not name are fine; extra files are unpacked too', async () => {
    const files = contractPackFiles();
    const items: ZipItem[] = [
      { name: `${CONTRACT_PACK_ID}/` },
      { name: `${CONTRACT_PACK_ID}/img/` },
      ...itemsOf(files).map((item) => ({ ...item, compress: false })),
      { name: `${CONTRACT_PACK_ID}/docs/readme.txt`, data: '說明' },
    ];

    const plan = planOf(await inspectItems(items));

    expect(plan.files.get('docs/readme.txt')?.toString('utf8')).toBe('說明');
    expect(plan.index.servedPaths).toStrictEqual(CONTRACT_SERVED_PATHS);
  });

  it.each<[string, string, string]>([
    [
      'a .. segment',
      `${CONTRACT_PACK_ID}/xx/a.txt`,
      `${CONTRACT_PACK_ID}/../a.txt`,
    ],
    [
      'a leading /',
      `${CONTRACT_PACK_ID}/aaa.txt`,
      `/${CONTRACT_PACK_ID}/aa.txt`,
    ],
    [
      'a drive letter',
      `${CONTRACT_PACK_ID}/aaa.txt`,
      `C:${CONTRACT_PACK_ID}/a.txt`,
    ],
    [
      'a backslash',
      `${CONTRACT_PACK_ID}/img/a.txt`,
      `${CONTRACT_PACK_ID}/img\\a.txt`,
    ],
  ])(
    '路徑不安全: %s is refused (yazl will not write one; patched in)',
    async (_label, written, patched) => {
      const zip = await zipBuffer([
        ...itemsOf(contractPackFiles()),
        { name: written, data: 'x' },
      ]);

      const rejection = rejectionOf(
        await inspectZip(patchName(zip, written, patched)),
      );

      expect(rejection).toStrictEqual({ code: 'unsafe-path', path: patched });
    },
  );

  it.each<[string, string, string?]>([
    ['a . segment', `${CONTRACT_PACK_ID}/./a.txt`],
    ['a doubled /', `${CONTRACT_PACK_ID}//a.txt`],
    ['a colon', `${CONTRACT_PACK_ID}/a:b.txt`],
    ['a Windows device name', `${CONTRACT_PACK_ID}/img/con.txt`],
    ['a device name in any case, as a folder', `${CONTRACT_PACK_ID}/Aux/a.txt`],
    [
      'a device name with a space before its dot',
      `${CONTRACT_PACK_ID}/con .png`,
    ],
    ['a superscript device number', `${CONTRACT_PACK_ID}/COM\u00b9.txt`],
    ['a name ending in .', `${CONTRACT_PACK_ID}/a.`],
    ['a name ending in a space', `${CONTRACT_PACK_ID}/a `],
    ['a space', `${CONTRACT_PACK_ID}/docs/read me.txt`],
    [
      'a control character, quoted escaped',
      `${CONTRACT_PACK_ID}/a\u0001.txt`,
      `${CONTRACT_PACK_ID}/a\\u0001.txt`,
    ],
    [
      'a bidi override, quoted escaped',
      `${CONTRACT_PACK_ID}/a\u202egnp.js`,
      `${CONTRACT_PACK_ID}/a\\u202egnp.js`,
    ],
    ['a character Windows forbids', `${CONTRACT_PACK_ID}/a?.txt`],
    // APFS folds ſ into s: entry.jſ would be written over entry.js.
    [
      'a letter APFS folds into an ASCII one',
      `${CONTRACT_PACK_ID}/entry.j\u017f`,
    ],
    ['a dotless i', `${CONTRACT_PACK_ID}/img/\u0131.png`],
    ['an accented letter', `${CONTRACT_PACK_ID}/caf\u00e9.txt`],
    ['a non-ASCII folder', `${CONTRACT_PACK_ID}/\u5716/`],
  ])('路徑不安全: %s is refused', async (_label, name, quoted = name) => {
    const rejection = rejectionOf(
      await inspectItems([
        ...itemsOf(contractPackFiles()),
        name.endsWith('/') ? { name } : { name, data: 'x' },
      ]),
    );

    expect(rejection).toStrictEqual({ code: 'unsafe-path', path: quoted });
  });

  it(`路徑不安全: names up to ${PACK_IMPORT_MAX_PATH_LENGTH} characters and ${PACK_IMPORT_MAX_PATH_SEGMENTS} segments pass; longer or deeper ones are refused`, async () => {
    const root = `${CONTRACT_PACK_ID}/`;
    const longest =
      root + 'a'.repeat(PACK_IMPORT_MAX_PATH_LENGTH - root.length);
    const deepest =
      root +
      Array(PACK_IMPORT_MAX_PATH_SEGMENTS - 1)
        .fill('d')
        .join('/');
    expect(longest).toHaveLength(PACK_IMPORT_MAX_PATH_LENGTH);
    expect(deepest.split('/')).toHaveLength(PACK_IMPORT_MAX_PATH_SEGMENTS);
    const files = itemsOf(contractPackFiles());

    expect(
      (await inspectItems([...files, { name: longest, data: 'x' }])).ok,
    ).toBe(true);
    expect(
      (await inspectItems([...files, { name: deepest, data: 'x' }])).ok,
    ).toBe(true);
    expect(
      rejectionOf(
        await inspectItems([...files, { name: `${longest}b`, data: 'x' }]),
      ),
    ).toStrictEqual({
      code: 'unsafe-path',
      path: `${longest}b`.slice(0, PACK_REJECTED_NAME_MAX_LENGTH) + '…',
    });
    expect(
      rejectionOf(
        await inspectItems([...files, { name: `${deepest}/e`, data: 'x' }]),
      ),
    ).toStrictEqual({ code: 'unsafe-path', path: `${deepest}/e` });
  });

  it('捷徑: a symbolic link (by its external attributes) is refused', async () => {
    const name = `${CONTRACT_PACK_ID}/img/link.png`;
    const rejection = rejectionOf(
      await inspectItems([
        ...itemsOf(contractPackFiles()),
        { name, data: '../../../secret', mode: 0o120777 },
      ]),
    );

    expect(rejection).toStrictEqual({ code: 'shortcut', path: name });
  });

  it.each(['shortcut.lnk', 'docs/Start.LNK'])(
    '捷徑: a .lnk file (%s) is refused',
    async (file) => {
      const rejection = rejectionOf(
        await inspectChanged((files) => {
          files.set(file, 'x');
        }),
      );

      expect(rejection).toStrictEqual({
        code: 'shortcut',
        path: `${CONTRACT_PACK_ID}/${file}`,
      });
    },
  );

  it('捷徑: a plain file with executable bits is not a shortcut', async () => {
    const files = contractPackFiles();
    const items = itemsOf(files).map((item) => ({ ...item, mode: 0o100755 }));

    expect((await inspectItems(items)).ok).toBe(true);
  });

  it.each<[string, ZipItem[]]>([
    [
      'a __MACOSX/ folder next to the pack folder',
      [{ name: `__MACOSX/${CONTRACT_PACK_ID}/._manifest.json`, data: 'x' }],
    ],
    ['a second folder', [{ name: 'other/readme.txt', data: 'x' }]],
    ['a file at the root', [{ name: 'readme.txt', data: 'x' }]],
    ['an empty folder at the root', [{ name: 'empty/' }]],
  ])('根目錄不對: %s is refused', async (_label, extra) => {
    const rejection = rejectionOf(
      await inspectItems([...itemsOf(contractPackFiles()), ...extra]),
    );

    expect(rejection).toStrictEqual({ code: 'invalid-root' });
  });

  it('根目錄不對: a zip with nothing in it is refused', async () => {
    expect(rejectionOf(await inspectItems([]))).toStrictEqual({
      code: 'invalid-root',
    });
  });

  it('根目錄不對: the pack files right at the root, with no folder, are refused', async () => {
    const items = [...contractPackFiles()].map(([name, data]) => ({
      name,
      data,
    }));

    expect(rejectionOf(await inspectItems(items))).toStrictEqual({
      code: 'invalid-root',
    });
  });

  it("根目錄不對: a folder not named after the manifest's id is refused, naming both", async () => {
    const rejection = rejectionOf(
      await inspectItems(itemsOf(contractPackFiles(), 'other-pack')),
    );

    expect(rejection).toStrictEqual({
      code: 'root-folder-mismatch',
      folder: 'other-pack',
      packId: CONTRACT_PACK_ID,
    });
  });

  it(`太大: ${PACK_IMPORT_MAX_FILES} files (folders not counted) pass; one more is refused`, async () => {
    const files: Map<string, Buffer | string> = contractPackFiles();
    for (let i = files.size; i < PACK_IMPORT_MAX_FILES; i += 1) {
      files.set(`extra/${i}.txt`, '');
    }
    expect(files.size).toBe(PACK_IMPORT_MAX_FILES);
    const items = [{ name: `${CONTRACT_PACK_ID}/extra/` }, ...itemsOf(files)];

    expect((await inspectItems(items)).ok).toBe(true);

    const rejection = rejectionOf(
      await inspectItems([
        ...items,
        { name: `${CONTRACT_PACK_ID}/one-more.txt`, data: '' },
      ]),
    );
    expect(rejection).toStrictEqual({
      code: 'too-large',
      limit: 'file-count',
    });
  });

  it(`太大: ${PACK_IMPORT_MAX_ENTRIES} entries, folders included, pass; one more is refused before any entry is read`, async () => {
    const files = itemsOf(contractPackFiles());
    const folders = Array.from(
      { length: PACK_IMPORT_MAX_ENTRIES - files.length },
      (_, i) => ({ name: `${CONTRACT_PACK_ID}/f${i}/` }),
    );

    expect((await inspectItems([...files, ...folders])).ok).toBe(true);

    const rejection = rejectionOf(
      await inspectItems([
        ...files,
        ...folders,
        { name: `${CONTRACT_PACK_ID}/one-more/` },
      ]),
    );
    expect(rejection).toStrictEqual({
      code: 'too-large',
      limit: 'entry-count',
    });
  });

  it('太大: a total unpacked size of exactly the limit passes', async () => {
    const used = [...contractPackFiles().values()].reduce(
      (sum, data) => sum + data.length,
      0,
    );

    const inspection = await inspectChanged((files) => {
      files.set('big.bin', Buffer.alloc(PACK_IMPORT_MAX_TOTAL_BYTES - used));
    });

    expect(inspection.ok).toBe(true);
  });

  it('太大: a total unpacked size over the limit is refused by the sizes declared, before reading', async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set('big.bin', Buffer.alloc(PACK_IMPORT_MAX_TOTAL_BYTES));
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'too-large',
      limit: 'total-size',
    });
  });

  it('太大: a file that unpacks to more bytes than it declares is stopped there', async () => {
    const name = `${CONTRACT_PACK_ID}/notes.txt`;
    const zip = await zipBuffer([
      ...itemsOf(contractPackFiles()),
      { name, data: 'a'.repeat(100_000) },
    ]);

    const rejection = rejectionOf(
      await inspectZip(patchDeclaredSize(zip, name, 10)),
    );

    expect(rejection).toStrictEqual({
      code: 'too-large',
      limit: 'declared-size',
    });
  });

  it('太大: a stored file longer than it declares is stopped too', async () => {
    const name = `${CONTRACT_PACK_ID}/notes.txt`;
    const zip = await zipBuffer([
      ...itemsOf(contractPackFiles()),
      { name, data: 'a'.repeat(1000), compress: false },
    ]);

    const rejection = rejectionOf(
      await inspectZip(patchDeclaredSize(zip, name, 10)),
    );

    expect(rejection).toStrictEqual({
      code: 'too-large',
      limit: 'declared-size',
    });
  });

  it('太大: a file shorter than it declares makes the zip invalid', async () => {
    const name = `${CONTRACT_PACK_ID}/notes.txt`;
    const zip = await zipBuffer([
      ...itemsOf(contractPackFiles()),
      { name, data: 'a'.repeat(1000) },
    ]);

    const rejection = rejectionOf(
      await inspectZip(patchDeclaredSize(zip, name, 5000)),
    );

    expect(rejection).toStrictEqual({ code: 'invalid-archive' });
  });

  it.each<[string, number, number]>([
    ['too wide', PACK_IMPORT_MAX_IMAGE_SIDE + 1, 1],
    ['too high', 1, PACK_IMPORT_MAX_IMAGE_SIDE + 1],
  ])(
    '圖片太大: an image %s is refused, naming it',
    async (_label, width, height) => {
      const rejection = rejectionOf(
        await inspectChanged((files) => {
          files.set('img/spark.png', pngHeader(width, height));
        }),
      );

      expect(rejection).toStrictEqual({
        code: 'image-too-large',
        limit: 'side',
        path: 'img/spark.png',
      });
    },
  );

  it("圖片太大: a spritesheet's image counts too", async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set(
          'img/probe-two-sheet.png',
          pngHeader(PACK_IMPORT_MAX_IMAGE_SIDE + 1, 2),
        );
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'image-too-large',
      limit: 'side',
      path: 'img/probe-two-sheet.png',
    });
  });

  it('圖片太大: images adding up to exactly the total limit pass (4 × 4000 × 4000)', async () => {
    expect(4 * 4000 * 4000).toBe(PACK_IMPORT_MAX_TOTAL_PIXELS);

    const inspection = await inspectChanged((files) => {
      for (const image of [
        'img/probe-one-plain.png',
        'img/probe-one-dots.png',
        'img/spark.png',
        'img/probe-two-sheet.png',
      ]) {
        files.set(image, pngHeader(4000, 4000));
      }
    });

    expect(inspection.ok).toBe(true);
  });

  it('圖片太大: images at the side limit pass while their total stays within its limit; one more of them goes over it', async () => {
    const side = PACK_IMPORT_MAX_IMAGE_SIDE;
    // 3 × 4096² ≈ 50.3 million pixels.
    const three = await inspectChanged((files) => {
      files.set('img/probe-one-plain.png', pngHeader(side, side));
      files.set('img/probe-one-dots.png', pngHeader(side, side));
      files.set('img/spark.png', pngHeader(side, side));
    });
    expect(three.ok).toBe(true);

    // 4 × 4096² ≈ 67.1 million pixels.
    const four = await inspectChanged((files) => {
      files.set('img/probe-one-plain.png', pngHeader(side, side));
      files.set('img/probe-one-dots.png', pngHeader(side, side));
      files.set('img/spark.png', pngHeader(side, side));
      files.set('img/probe-two-sheet.png', pngHeader(side, side));
    });
    expect(rejectionOf(four)).toStrictEqual({
      code: 'image-too-large',
      limit: 'total-pixels',
    });
  });

  it.each<[string, Buffer]>([
    ['a GIF', Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')],
    ['an empty file', Buffer.alloc(0)],
    [
      'a PNG signature without IHDR first',
      Buffer.concat([
        pngHeader(2, 2).subarray(0, 12),
        Buffer.from('IDAT'),
        Buffer.alloc(8),
      ]),
    ],
    ['a PNG 0 pixels wide', pngHeader(0, 2)],
  ])('圖片格式: an image asset that is %s is refused', async (_label, data) => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set('img/spark.png', data);
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'unsupported-image-format',
      path: 'img/spark.png',
    });
  });

  it.each(['img/spark.PNG', 'img/spark.webp', 'img/spark'])(
    '圖片格式: an image asset named %s is refused even with PNG bytes',
    async (renamed) => {
      const rejection = rejectionOf(
        await inspectChanged((files) => {
          const manifest = contractManifest();
          assetsOf(manifest).spark!.path = renamed;
          files.set('manifest.json', manifestBytes(manifest));
          files.set(renamed, files.get('img/spark.png')!);
          files.delete('img/spark.png');
        }),
      );

      expect(rejection).toStrictEqual({
        code: 'unsupported-image-format',
        path: renamed,
      });
    },
  );

  it("圖片格式: a spritesheet's image that is not a PNG is refused", async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set('img/probe-two-sheet.png', 'not a png');
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'unsupported-image-format',
      path: 'img/probe-two-sheet.png',
    });
  });

  it('manifest 不對: no manifest.json is refused', async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.delete('manifest.json');
      }),
    );

    expect(rejection).toStrictEqual({ code: 'missing-manifest' });
  });

  it('manifest 不對: a manifest.json in a subfolder does not count', async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set('sub/manifest.json', files.get('manifest.json')!);
        files.delete('manifest.json');
      }),
    );

    expect(rejection).toStrictEqual({ code: 'missing-manifest' });
  });

  it('manifest 不對: a manifest that is not JSON is refused', async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set('manifest.json', '{ "id": "contract-pack",');
      }),
    );

    expect(rejection).toStrictEqual({ code: 'manifest-not-json' });
  });

  it('manifest 不對: a manifest saved with a UTF-8 BOM is read', async () => {
    const inspection = await inspectChanged((files) => {
      files.set(
        'manifest.json',
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          manifestBytes(contractManifest()),
        ]),
      );
    });

    expect(inspection.ok).toBe(true);
  });

  it('manifest 不對: a manifest that fails the schema is refused with each issue: zod code, pack API rule, field path', async () => {
    const rejection = rejectionOf(
      await inspectWithManifest((manifest) => {
        manifest.name = '   ';
        manifest.homepage = 'x';
        (manifest.characters as Record<string, unknown>[])[1]!.height = 0;
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'invalid-manifest',
      issues: expect.arrayContaining([
        { code: 'custom', rule: 'blank-label', path: ['name'] },
        { code: 'unrecognized_keys', path: ['homepage'] },
        { code: 'too_small', path: ['characters', 1, 'height'] },
      ]),
    });
    expect(
      rejection.code === 'invalid-manifest' && rejection.issues,
    ).toHaveLength(3);
    expect(packsLines()).toStrictEqual([
      '[packs] refused a pack: invalid-manifest (3 issues)',
    ]);
  });

  it('manifest 不對: two manifest paths that differ only in case are refused as a manifest issue', async () => {
    const rejection = rejectionOf(
      await inspectWithManifest((manifest) => {
        assetsOf(manifest).spark!.path = 'IMG/Probe-One-Plain.png';
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'invalid-manifest',
      issues: [
        {
          code: 'custom',
          rule: 'pack-path-case-conflict',
          path: ['assets', 'spark', 'path'],
        },
      ],
    });
  });

  it('manifest 不對: a manifest path that is a Windows device name is refused as a manifest issue', async () => {
    const rejection = rejectionOf(
      await inspectWithManifest((manifest) => {
        assetsOf(manifest).spark!.path = 'img/con.png';
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'invalid-manifest',
      issues: [
        {
          code: 'custom',
          rule: 'pack-path-device-name',
          path: ['assets', 'spark', 'path'],
        },
      ],
    });
  });

  it.each([
    'entry.js',
    'img/probe-one-dots.png',
    'img/probe-two-sheet.json',
    'img/probe-two-sheet.png',
  ])('引用不存在: a pack without %s is refused, naming it', async (missing) => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.delete(missing);
      }),
    );

    expect(rejection).toStrictEqual({ code: 'missing-file', path: missing });
  });

  it('引用不存在: a file whose name differs from the manifest only in case is missing', async () => {
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        files.set('img/Spark.png', files.get('img/spark.png')!);
        files.delete('img/spark.png');
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'missing-file',
      path: 'img/spark.png',
    });
  });

  it.each<[string, string, string]>([
    ['a syntax error', '(function (stage) { return {', 'syntax-error'],
    [
      'an ESM import',
      "import x from 'y';\n(function (stage) { return {}; });",
      'syntax-error',
    ],
    [
      'an ESM export',
      'export default function (stage) { return {}; }',
      'syntax-error',
    ],
    [
      'sloppy-mode-only syntax (with)',
      'with (Math) { max(1, 2); }\n(function () {});',
      'syntax-error',
    ],
    [
      'a require call',
      "const fs = require('fs');\n(function (stage) { return {}; });",
      'require',
    ],
    [
      'a require call in a comment',
      '// require(x)\n(function (stage) { return {}; });',
      'require',
    ],
    [
      'a dynamic import',
      "(function (stage) { import('x'); return {}; });",
      'dynamic-import',
    ],
    [
      'an import expression with a comment before (',
      '(function (stage) { import /* x */ ("y"); return {}; });',
      'dynamic-import',
    ],
    [
      'an import expression in a string',
      '(function (stage) { return { note: "import(x)" }; });',
      'dynamic-import',
    ],
    ['an HTML comment opener', '/* <!-- */\n(function () {});', 'html-comment'],
    [
      'an HTML comment closer',
      'let a = 2; a-->0;\n(function () {});',
      'html-comment',
    ],
    [
      'a direct eval',
      '(function (stage) { return { frame() { return eval("1"); } }; });',
      'direct-eval',
    ],
    [
      'a direct eval with a space before (',
      '(function (stage) { eval ("1"); return {}; });',
      'direct-eval',
    ],
    [
      'a require with a comment before (',
      '(function (stage) { require/**/("fs"); return {}; });',
      'require',
    ],
    [
      'a require after a dot',
      '(function (stage) { stage.require("fs"); return {}; });',
      'require',
    ],
  ])(
    '入口不行: an entry with %s is refused',
    async (_label, source, reason) => {
      const rejection = rejectionOf(
        await inspectChanged((files) => {
          files.set('entry.js', source);
        }),
      );

      expect(rejection).toStrictEqual({ code: 'entry-unparsable', reason });
    },
  );

  it('入口不行: an entry is compiled, never run', async () => {
    const marker = '__awpPackEntryRan';
    const inspection = await inspectChanged((files) => {
      files.set(
        'entry.js',
        `globalThis.${marker} = true;\nthrow new Error('ran');\n(function (stage) { return {}; });`,
      );
    });

    expect(inspection.ok).toBe(true);
    expect(Object.hasOwn(globalThis, marker)).toBe(false);
  });

  it.each([
    // Defining such a method (`{ import(x) {} }`) would match, as in SES.
    [
      'obj.import(',
      '(function (stage) { return { frame() { return stage.import(1); } }; });',
    ],
    [
      'obj.eval(',
      '(function (stage) { return { frame() { return stage.eval(1); } }; });',
    ],
    [
      'a name ending in eval',
      '(function (stage) { const myeval = (x) => x; return { frame() { return myeval(1); } }; });',
    ],
  ])('入口不行: %s is not refused', async (_label, source) => {
    const inspection = await inspectChanged((files) => {
      files.set('entry.js', source);
    });

    expect(inspection.ok, JSON.stringify(inspection)).toBe(true);
  });

  it('入口不行: names like requireAll( or .required are not require calls', async () => {
    const inspection = await inspectChanged((files) => {
      files.set(
        'entry.js',
        '(function (stage) { const requireAll = (x) => x; return { frame(m) { return requireAll(m.required); } }; });',
      );
    });

    expect(inspection.ok).toBe(true);
  });

  it.each<[string, string]>([
    ['1.1', 'pack-newer'],
    ['1.12', 'pack-newer'],
    ['2.0', 'major-mismatch'],
    ['0.9', 'major-mismatch'],
  ])(
    '版本: apiVersion %s is refused as %s, with the version it needs',
    async (apiVersion, reason) => {
      const rejection = rejectionOf(
        await inspectWithManifest((manifest) => {
          manifest.apiVersion = apiVersion;
        }),
      );

      expect(rejection).toStrictEqual({
        code: 'api-incompatible',
        reason,
        required: apiVersion,
      });
    },
  );

  it('版本: is checked before the whole schema: a newer manifest with fields this stage does not know is told the version', async () => {
    const rejection = rejectionOf(
      await inspectWithManifest((manifest) => {
        manifest.apiVersion = '1.1';
        manifest.interactions = { pickUp: true };
        manifest.name = '';
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'api-incompatible',
      reason: 'pack-newer',
      required: '1.1',
    });
  });

  it('版本: a missing or malformed apiVersion is a manifest issue', async () => {
    const rejection = rejectionOf(
      await inspectWithManifest((manifest) => {
        manifest.apiVersion = 'v1';
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'invalid-manifest',
      issues: [{ code: 'invalid_format', path: ['apiVersion'] }],
    });
  });

  it.each<[string, ZipItem[], string]>([
    [
      'two files',
      [{ name: `${CONTRACT_PACK_ID}/img/Spark.png`, data: 'x' }],
      `${CONTRACT_PACK_ID}/img/Spark.png`,
    ],
    [
      'two folders',
      [{ name: `${CONTRACT_PACK_ID}/IMG/other.png`, data: 'x' }],
      `${CONTRACT_PACK_ID}/IMG`,
    ],
    [
      'a file and a folder',
      [{ name: `${CONTRACT_PACK_ID}/entry.js/a.txt`, data: 'x' }],
      `${CONTRACT_PACK_ID}/entry.js`,
    ],
    [
      'the same file twice',
      [{ name: `${CONTRACT_PACK_ID}/entry.js`, data: 'x' }],
      `${CONTRACT_PACK_ID}/entry.js`,
    ],
  ])(
    '大小寫衝突: %s whose names differ only in case are refused, naming the later one',
    async (_label, extra, conflict) => {
      const rejection = rejectionOf(
        await inspectItems([...itemsOf(contractPackFiles()), ...extra]),
      );

      expect(rejection).toStrictEqual({
        code: 'name-conflict',
        path: conflict,
      });
    },
  );

  it('大小寫衝突: a folder entry and the files in it are no conflict', async () => {
    const inspection = await inspectItems([
      { name: `${CONTRACT_PACK_ID}/img/` },
      ...itemsOf(contractPackFiles()),
      { name: `${CONTRACT_PACK_ID}/img/` },
    ]);

    expect(inspection.ok).toBe(true);
  });

  function installedAt(version: string): InstalledPackLookup {
    return {
      find: (packId) =>
        packId === CONTRACT_PACK_ID ? { name: '舊的名稱', version } : undefined,
    };
  }

  it.each<[string, string, boolean, string]>([
    ['an older version', '0.9.3', false, '; replaces the installed version'],
    ['the same version', '1.0.0', false, '; replaces the installed version'],
    ['a newer version', '1.0.1', true, '; older than the installed version'],
    [
      'a version newer by its minor only (1.10 > 1.9 > 1.0)',
      '1.10.0',
      true,
      '; older than the installed version',
    ],
  ])(
    '已安裝: with %s installed, the plan names both and says whether it is a downgrade',
    async (_label, version, downgrade, note) => {
      const plan = planOf(
        await inspectItems(itemsOf(contractPackFiles()), installedAt(version)),
      );

      expect(plan.previous).toStrictEqual({ name: '舊的名稱', version });
      expect(plan.name).toBe('契約測試包');
      expect(plan.version).toBe('1.0.0');
      expect(plan.downgrade).toBe(downgrade);
      expect(packsLines()).toStrictEqual([
        `[packs] checked pack ${CONTRACT_PACK_ID}: 7 files, ready to install${note}`,
      ]);
    },
  );
});

describe('spritesheet', () => {
  function withSheet(sheet: unknown) {
    return inspectChanged((files) => {
      files.set(
        'img/probe-two-sheet.json',
        typeof sheet === 'string' ? sheet : JSON.stringify(sheet),
      );
    });
  }

  const IMAGE = 'probe-two-sheet.png';

  it.each<[string, unknown]>([
    ['not JSON', '{"frames": '],
    ['not an object', '[1]'],
    ['no frames', { meta: { image: IMAGE } }],
    ['frames that are a list', { frames: [], meta: { image: IMAGE } }],
    ['no meta', { frames: {} }],
    ['no meta.image', { frames: {}, meta: { size: { w: 4, h: 2 } } }],
    ['a meta.image that is not a string', { frames: {}, meta: { image: 7 } }],
    ['an empty meta.image', { frames: {}, meta: { image: '' } }],
    [
      'a meta.image starting with /',
      { frames: {}, meta: { image: `/img/${IMAGE}` } },
    ],
    [
      'a meta.image leaving the pack',
      { frames: {}, meta: { image: `../../${IMAGE}` } },
    ],
    // Each would be normalized into a real file, then 404 when PixiJS
    // asks for it as written.
    [
      'a meta.image going up and back',
      { frames: {}, meta: { image: `../img/${IMAGE}` } },
    ],
    [
      'a meta.image with a . segment',
      { frames: {}, meta: { image: `./${IMAGE}` } },
    ],
    [
      'a meta.image with an empty segment',
      { frames: {}, meta: { image: `sub//${IMAGE}` } },
    ],
    [
      'a meta.image with a query',
      { frames: {}, meta: { image: `${IMAGE}?v=2` } },
    ],
    [
      'a meta.image that is a URL',
      { frames: {}, meta: { image: 'https://example.com/a.png' } },
    ],
    [
      'meta.related_multi_packs (PixiJS would fetch those sheets too)',
      {
        frames: {},
        meta: { image: IMAGE, related_multi_packs: ['other.json'] },
      },
    ],
  ])(
    'a spritesheet with %s is refused, naming the JSON',
    async (_label, sheet) => {
      expect(rejectionOf(await withSheet(sheet))).toStrictEqual({
        code: 'invalid-spritesheet',
        path: 'img/probe-two-sheet.json',
      });
    },
  );

  it('a spritesheet whose path does not end in .json is refused', async () => {
    const renamed = 'img/probe-two-sheet.txt';
    const rejection = rejectionOf(
      await inspectChanged((files) => {
        const manifest = contractManifest();
        assetsOf(manifest)['probe-two-sheet']!.path = renamed;
        files.set('manifest.json', manifestBytes(manifest));
        files.set(renamed, files.get('img/probe-two-sheet.json')!);
        files.delete('img/probe-two-sheet.json');
      }),
    );

    expect(rejection).toStrictEqual({
      code: 'invalid-spritesheet',
      path: renamed,
    });
  });

  it("a meta.image in a subfolder of the JSON's folder is served as that file", async () => {
    const inspection = await inspectChanged((files) => {
      files.set('img/sub/sheet.png', files.get(`img/${IMAGE}`)!);
      files.set(
        'img/probe-two-sheet.json',
        JSON.stringify({ frames: {}, meta: { image: 'sub/sheet.png' } }),
      );
    });

    expect(planOf(inspection).index.servedPaths).toContain('img/sub/sheet.png');
  });
});

describe('the file itself', () => {
  it.each<[string, () => string]>([
    ['a missing file', () => path.join(dir, 'missing.awpet')],
    ['a folder', () => dir],
  ])('%s is unreadable-file', async (_label, file) => {
    expect(
      rejectionOf(await inspectPack(file(), NOTHING_INSTALLED)),
    ).toStrictEqual({
      code: 'unreadable-file',
    });
  });

  it.each<[string, Buffer]>([
    ['not a zip', Buffer.from('this is not a zip file at all')],
    ['empty', Buffer.alloc(0)],
  ])('a file that is %s is invalid-archive', async (_label, data) => {
    expect(rejectionOf(await inspectZip(data))).toStrictEqual({
      code: 'invalid-archive',
    });
  });

  it('an encrypted entry is invalid-archive', async () => {
    const name = `${CONTRACT_PACK_ID}/secret.txt`;
    const zip = await zipBuffer([
      ...itemsOf(contractPackFiles()),
      { name, data: 'x' },
    ]);
    // Set bit 0 (encrypted) of the entry's general purpose flags in the
    // central directory.
    const out = Buffer.from(zip);
    const wanted = Buffer.from(name);
    for (let at = 0; at + 46 <= out.length; at += 1) {
      if (
        out.readUInt32LE(at) === 0x02014b50 &&
        out
          .subarray(at + 46, at + 46 + out.readUInt16LE(at + 28))
          .equals(wanted)
      ) {
        out.writeUInt16LE(out.readUInt16LE(at + 8) | 1, at + 8);
      }
    }

    expect(rejectionOf(await inspectZip(out))).toStrictEqual({
      code: 'invalid-archive',
    });
  });

  it('a damaged deflate stream is invalid-archive', async () => {
    const name = `${CONTRACT_PACK_ID}/notes.txt`;
    const zip = Buffer.from(
      await zipBuffer([
        ...itemsOf(contractPackFiles()),
        { name, data: 'a'.repeat(1000) },
      ]),
    );
    // The entry's data follows its local header (30 bytes, name, extra).
    const header = zip.indexOf(Buffer.from(name)) - 30;
    expect(zip.readUInt32LE(header)).toBe(0x04034b50);
    const data =
      header +
      30 +
      zip.readUInt16LE(header + 26) +
      zip.readUInt16LE(header + 28);
    zip.fill(0xff, data, data + 4);

    expect(rejectionOf(await inspectZip(zip))).toStrictEqual({
      code: 'invalid-archive',
    });
  });

  it('a file system error while reading a file is unreadable-file, not a damaged zip', async () => {
    vi.spyOn(
      yauzl.ZipFile.prototype,
      'openReadStreamPromise',
    ).mockResolvedValue(
      new Readable({
        read() {
          this.destroy(
            Object.assign(new Error('EIO: i/o error, read'), {
              code: 'EIO',
              errno: -5,
              syscall: 'read',
            }),
          );
        },
      }),
    );

    expect(
      rejectionOf(await inspectItems(itemsOf(contractPackFiles()))),
    ).toStrictEqual({
      code: 'unreadable-file',
    });
  });

  it.each<[string, unknown, string]>([
    [
      'a file system error',
      Object.assign(new Error('x'), {
        code: 'EACCES',
        errno: -13,
        syscall: 'open',
      }),
      'unreadable-file',
    ],
    [
      'a Node ERR_ error',
      Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_VALUE' }),
      'invalid-archive',
    ],
    [
      'a zlib error (an errno, no system call)',
      Object.assign(new Error('x'), { code: 'Z_DATA_ERROR', errno: -3 }),
      'invalid-archive',
    ],
    [
      "one of yauzl's own errors",
      new Error('invalid central directory file header signature'),
      'invalid-archive',
    ],
    ['not an Error', 'boom', 'invalid-archive'],
  ])('rejectionFor: %s is %s', (_label, error, code) => {
    expect(rejectionFor(error)).toStrictEqual({ code });
  });

  it('logs codes and the pack id only, never a path on the disk or a name from the zip', async () => {
    await inspectPack(path.join(dir, 'missing.awpet'), NOTHING_INSTALLED);
    await inspectItems([
      ...itemsOf(contractPackFiles()),
      { name: `${CONTRACT_PACK_ID}/a:b.txt`, data: 'x' },
    ]);
    await inspectChanged((files) => {
      files.delete('img/spark.png');
    });

    expect(packsLines()).toStrictEqual([
      '[packs] refused a pack: unreadable-file',
      '[packs] refused a pack: unsafe-path',
      `[packs] refused pack ${CONTRACT_PACK_ID}: missing-file`,
    ]);
    expect(packsLines().join('\n')).not.toContain(dir);
  });
});
