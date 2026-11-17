/**
 * main/packs store (Story 3.2): packs/index.json (loading, broken files,
 * migrations, save), the start-up cleanup of what an install left behind,
 * and the packs section as StageView carries it. Real files in a temp
 * folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadPacks,
  PACKS_MIGRATIONS,
  type PacksFs,
  type PacksStoreOptions,
} from '../../src/main/packs/store';
import {
  packIndexFileSchema,
  stagePacksSchema,
  type PackIndexEntry,
} from '../../src/shared/packs';

/** Local time, so the backup suffix below is the same in every time zone. */
const NOW = new Date(2026, 10, 16, 9, 30, 5).getTime();
const BACKUP = 'index.json.broken-20261116-093005';

const ALPHA: PackIndexEntry = {
  id: 'alpha-pack',
  name: '甲包',
  version: '1.2.0',
  apiVersion: '1.0',
  characters: [{ id: 'probe-a', name: '探針甲', height: 110 }],
  servedPaths: ['entry.js', 'img/a.png'],
};
const BETA: PackIndexEntry = {
  id: 'beta-pack',
  name: '乙包',
  version: '0.3.1',
  apiVersion: '1.0',
  characters: [
    { id: 'probe-b', name: '探針乙', height: 96.5 },
    { id: 'probe-c', name: '探針丙', height: 140 },
  ],
  servedPaths: ['main.js'],
};

/** What StageView carries of an entry (whose apiVersion fits). */
function staged({ servedPaths: _served, ...pack }: PackIndexEntry) {
  return { ...pack, compatibility: { compatible: true } };
}

let root: string;
let dir: string;
let index: string;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-store-'));
  dir = path.join(root, 'packs');
  index = path.join(dir, 'index.json');
  consoleSpies = (['info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function packsLines(level?: 'info' | 'warn' | 'error'): string[] {
  const spies =
    level === undefined
      ? consoleSpies
      : [consoleSpies[['info', 'warn', 'error'].indexOf(level)]!];
  return spies
    .flatMap((spy) => spy.mock.calls.map((call: unknown[]) => String(call[0])))
    .filter((line) => line.startsWith('[packs] '));
}

function load(options: Partial<PacksStoreOptions> = {}) {
  return loadPacks({ dir, now: () => NOW, ...options });
}

function writeIndex(content: unknown): string {
  const text =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(index, text);
  return text;
}

/** Makes each folder (relative to the packs folder) with a file in it. */
function makeFolders(...folders: string[]): void {
  for (const folder of folders) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, 'file.txt'), 'x');
  }
}

/** Everything under the packs folder, `/`-separated, sorted. */
function tree(): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .sort();
}

function fsWith(overrides: Partial<PacksFs>): PacksFs {
  return { ...fs, ...overrides } as unknown as PacksFs;
}

function failWith(code: string) {
  return () => {
    throw Object.assign(new Error(`${code}: ${index}`), { code });
  };
}

describe('loading index.json', () => {
  it('starts with no packs, creating nothing, when there is no index.json (nor packs folder)', () => {
    const store = load();

    expect(store.get()).toStrictEqual({ packs: { installed: [] } });
    expect(store.list()).toStrictEqual([]);
    expect(store.canWrite).toBe(true);
    expect(store.dir).toBe(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(packsLines()).toStrictEqual([
      '[packs] no index.json; no packs installed',
    ]);
  });

  it('reads a valid index.json, sorted by id, and leaves it as it was', () => {
    const text = writeIndex({ schemaVersion: 1, packs: [BETA, ALPHA] });
    makeFolders('alpha-pack/1.2.0', 'beta-pack/0.3.1');

    const store = load();

    expect(store.list()).toStrictEqual([ALPHA, BETA]);
    expect(store.find('beta-pack')).toStrictEqual(BETA);
    expect(store.find('gamma-pack')).toBeUndefined();
    expect(store.find('__proto__')).toBeUndefined();
    expect(store.get()).toStrictEqual({
      packs: { installed: [staged(ALPHA), staged(BETA)] },
    });
    expect(stagePacksSchema.safeParse(store.get().packs).success).toBe(true);
    expect(fs.readFileSync(index, 'utf8')).toBe(text);
    expect(packsLines()).toStrictEqual(['[packs] loaded index.json: 2 packs']);
  });

  it('reads an index.json saved with a UTF-8 BOM', () => {
    writeIndex(
      String.fromCharCode(0xfeff) +
        JSON.stringify({ schemaVersion: 1, packs: [ALPHA] }),
    );
    makeFolders('alpha-pack/1.2.0');

    expect(load().list()).toStrictEqual([ALPHA]);
  });

  it('keeps an index.json it cannot read, writes nothing this run, and says so', () => {
    writeIndex({ schemaVersion: 1, packs: [ALPHA] });

    const store = load({
      fs: fsWith({
        readFileSync: failWith('EACCES') as PacksFs['readFileSync'],
      }),
    });

    expect(store.list()).toStrictEqual([]);
    expect(store.canWrite).toBe(false);
    expect(() => store.save([ALPHA])).toThrow(/not written this run/);
    expect(JSON.parse(fs.readFileSync(index, 'utf8'))).toStrictEqual({
      schemaVersion: 1,
      packs: [ALPHA],
    });
    expect(packsLines('error')).toStrictEqual([
      '[packs] cannot read index.json (EACCES); starting with no packs installed and not writing index.json this run',
    ]);
  });
});

describe('I/O matrix', () => {
  it('不相容: says of each pack whether its apiVersion fits this stage, and if not why and the version it needs', () => {
    const newer = { ...ALPHA, apiVersion: '1.9' };
    const other = { ...BETA, apiVersion: '2.0' };
    writeIndex({ schemaVersion: 1, packs: [newer, other] });
    makeFolders('alpha-pack/1.2.0', 'beta-pack/0.3.1');

    const store = load();

    expect(store.list()).toStrictEqual([newer, other]);
    expect(
      store.get().packs.installed.map((pack) => pack.compatibility),
    ).toStrictEqual([
      { compatible: false, reason: 'pack-newer', required: '1.9' },
      { compatible: false, reason: 'major-mismatch', required: '2.0' },
    ]);
    expect(stagePacksSchema.safeParse(store.get().packs).success).toBe(true);
  });

  it.each([
    ['not JSON', '{"schemaVersion": 1, "packs": [', 'not valid JSON'],
    ['empty', '', 'not valid JSON'],
    ['a JSON array', '[]', 'not a JSON object'],
    ['missing schemaVersion', '{"packs": []}', 'schemaVersion is missing'],
    [
      'a string schemaVersion',
      '{"schemaVersion": "1", "packs": []}',
      'schemaVersion is not a positive integer',
    ],
    [
      'a newer schemaVersion',
      '{"schemaVersion": 2, "packs": []}',
      'schemaVersion 2 is newer than this build supports (1)',
    ],
    [
      'no packs list',
      '{"schemaVersion": 1}',
      'does not match the schema (fields: packs)',
    ],
    [
      'one pack id twice',
      JSON.stringify({ schemaVersion: 1, packs: [ALPHA, ALPHA] }),
      'does not match the schema (fields: packs)',
    ],
    [
      'a served path leaving the pack',
      JSON.stringify({
        schemaVersion: 1,
        packs: [{ ...ALPHA, servedPaths: ['../secret.txt'] }],
      }),
      'does not match the schema (fields: packs.0.servedPaths.0)',
    ],
    [
      'an unknown field',
      JSON.stringify({ schemaVersion: 1, packs: [], enabled: [] }),
      'does not match the schema (fields: enabled)',
    ],
  ])(
    '索引壞了: %s: renamed to .broken-<time>, no packs installed, one error line',
    (_label, text, reason) => {
      writeIndex(text);

      const store = load();

      expect(store.list()).toStrictEqual([]);
      expect(store.canWrite).toBe(true);
      expect(tree()).toStrictEqual([BACKUP]);
      expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
      expect(packsLines('error')).toStrictEqual([
        `[packs] index.json is unusable (${reason}); renamed it to ${BACKUP} and starting with no packs installed`,
      ]);
    },
  );

  it('索引壞了: when the rename fails too, nothing is written this run', () => {
    writeIndex('not json');

    const store = load({
      fs: fsWith({ renameSync: failWith('EPERM') }),
    });

    expect(store.canWrite).toBe(false);
    expect(tree()).toStrictEqual(['index.json']);
    expect(packsLines('error')).toStrictEqual([
      '[packs] index.json is unusable (not valid JSON) and could not be renamed (EPERM); starting with no packs installed and not writing index.json this run',
    ]);
  });

  it('殘留: removes temporary folders, a leftover index.json.tmp, old versions of installed packs and folders of packs not installed, in one line; leaves the rest', () => {
    writeIndex({ schemaVersion: 1, packs: [ALPHA, BETA] });
    makeFolders(
      '.staging-1',
      '.backup-2',
      // A backup of a version whose folder is there: not needed.
      '.backup-alpha-pack@1.2.0@t9',
      'alpha-pack/1.2.0',
      'alpha-pack/1.1.9',
      'alpha-pack/0.1.0',
      'beta-pack/0.3.1',
      'gone-pack/2.0.0',
      // Not names main/packs makes: left alone.
      'Not A Pack',
      'beta-pack/notes',
    );
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(dir, 'index.json.tmp'), '{"schemaVersion"');

    const store = load();

    expect(store.list()).toStrictEqual([ALPHA, BETA]);
    expect(tree()).toStrictEqual([
      '.DS_Store',
      'Not A Pack',
      'Not A Pack/file.txt',
      'alpha-pack',
      'alpha-pack/1.2.0',
      'alpha-pack/1.2.0/file.txt',
      'beta-pack',
      'beta-pack/0.3.1',
      'beta-pack/0.3.1/file.txt',
      'beta-pack/notes',
      'beta-pack/notes/file.txt',
      'index.json',
    ]);
    expect(packsLines()).toStrictEqual([
      '[packs] loaded index.json: 2 packs',
      '[packs] start-up cleanup: removed 7 leftovers (4 temporary, 2 old versions, 1 of packs not installed)',
    ]);
  });

  it.each<[string, () => Partial<PacksStoreOptions>]>([
    ['with no index.json', () => ({})],
    [
      'with an index.json it cannot read',
      () => {
        writeIndex({ schemaVersion: 1, packs: [] });
        return {
          fs: fsWith({
            readFileSync: failWith('EACCES') as PacksFs['readFileSync'],
          }),
        };
      },
    ],
  ])(
    '殘留: %s, only .staging- folders and index.json.tmp go; pack folders and backups stay, counted in one line',
    (_label, setUp) => {
      makeFolders(
        '.staging-1',
        '.backup-alpha-pack@1.2.0@t1',
        'alpha-pack/1.2.0',
        'alpha-pack/1.1.0',
        'beta-pack/0.3.1',
      );
      fs.writeFileSync(path.join(dir, 'index.json.tmp'), 'x');

      const store = load(setUp());

      expect(store.list()).toStrictEqual([]);
      expect(
        tree().filter((entry) => !entry.endsWith('file.txt')),
      ).toStrictEqual([
        '.backup-alpha-pack@1.2.0@t1',
        'alpha-pack',
        'alpha-pack/1.1.0',
        'alpha-pack/1.2.0',
        'beta-pack',
        'beta-pack/0.3.1',
        ...(fs.existsSync(index) ? ['index.json'] : []),
      ]);
      expect(packsLines('info')).toContain(
        '[packs] start-up cleanup: removed 2 leftovers (2 temporary, 0 old versions, 0 of packs not installed)',
      );
      expect(packsLines('info')).toContain(
        '[packs] start-up cleanup: index.json was not loaded, so 2 pack folders and 1 backups were kept',
      );
    },
  );

  it('殘留: with an unusable index.json, only temporary folders go: nothing says which pack folders are still wanted', () => {
    writeIndex('not json');
    makeFolders('.staging-1', 'alpha-pack/1.2.0', 'alpha-pack/1.1.0');

    load();

    expect(tree()).toStrictEqual([
      'alpha-pack',
      'alpha-pack/1.1.0',
      'alpha-pack/1.1.0/file.txt',
      'alpha-pack/1.2.0',
      'alpha-pack/1.2.0/file.txt',
      BACKUP,
    ]);
    expect(packsLines('info')).toStrictEqual([
      '[packs] start-up cleanup: removed 1 leftovers (1 temporary, 0 old versions, 0 of packs not installed)',
      '[packs] start-up cleanup: index.json was not loaded, so 1 pack folders and 0 backups were kept',
    ]);
  });

  it('殘留: a backup of the installed version whose folder is missing goes back in place before anything is removed', () => {
    writeIndex({ schemaVersion: 1, packs: [ALPHA] });
    makeFolders('.backup-alpha-pack@1.2.0@t1', '.backup-alpha-pack@1.1.0@t2');

    const store = load();

    expect(store.list()).toStrictEqual([ALPHA]);
    expect(tree()).toStrictEqual([
      'alpha-pack',
      'alpha-pack/1.2.0',
      'alpha-pack/1.2.0/file.txt',
      'index.json',
    ]);
    expect(packsLines('warn')).toStrictEqual([
      '[packs] start-up cleanup: put pack alpha-pack back from its backup',
    ]);
    expect(packsLines('error')).toStrictEqual([]);
  });

  it('殘留: logs nothing when there is nothing to remove', () => {
    writeIndex({ schemaVersion: 1, packs: [ALPHA] });
    makeFolders('alpha-pack/1.2.0');

    load();

    expect(packsLines()).toStrictEqual(['[packs] loaded index.json: 1 pack']);
  });

  it('殘留: logs the leftovers it could not remove, by error code, and keeps going', () => {
    writeIndex({ schemaVersion: 1, packs: [ALPHA] });
    makeFolders(
      '.staging-1',
      '.backup-2',
      'alpha-pack/1.0.0',
      'alpha-pack/1.2.0',
    );
    const rmSync = vi.fn((target: string) => {
      if (path.basename(target) === '.staging-1') {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      fs.rmSync(target, { recursive: true, force: true });
    });

    load({ fs: fsWith({ rmSync: rmSync as PacksFs['rmSync'] }) });

    expect(tree()).toContain('.staging-1');
    expect(tree()).not.toContain('.backup-2');
    expect(tree()).not.toContain('alpha-pack/1.0.0');
    expect(packsLines('error')).toStrictEqual([
      '[packs] start-up cleanup could not remove or restore 1 leftovers (EBUSY)',
    ]);
  });
});

describe('a pack whose folder is missing', () => {
  it('is left out of the list with one error line each; index.json is not rewritten', () => {
    const text = writeIndex({ schemaVersion: 1, packs: [ALPHA, BETA] });
    makeFolders('beta-pack/0.3.1');

    const store = load();

    expect(store.list()).toStrictEqual([BETA]);
    expect(store.find('alpha-pack')).toBeUndefined();
    expect(store.get()).toStrictEqual({ packs: { installed: [staged(BETA)] } });
    expect(fs.readFileSync(index, 'utf8')).toBe(text);
    expect(packsLines('error')).toStrictEqual([
      '[packs] pack alpha-pack: its folder is missing; leaving it out (index.json not rewritten)',
    ]);
  });
});

describe('migrations', () => {
  it('runs the forward-only migrations up to the version this build reads, then checks the schema', () => {
    writeIndex({ schemaVersion: 1, list: [ALPHA] });
    makeFolders('alpha-pack/1.2.0');

    const store = load({
      schemaVersion: 2,
      migrations: {
        1: ({ list, ...rest }) => ({ ...rest, packs: list }),
      },
    });

    expect(store.list()).toStrictEqual([ALPHA]);
    expect(packsLines()).toContain(
      '[packs] migrated index.json from schemaVersion 1 to 2',
    );
  });

  it('has no migrations while index.json is at schemaVersion 1', () => {
    expect(PACKS_MIGRATIONS).toStrictEqual({});
    expect(Object.isFrozen(PACKS_MIGRATIONS)).toBe(true);
  });
});

describe('save', () => {
  it('writes index.json (sorted, temp file renamed over it), then takes the entries and tells the listeners', () => {
    const store = load();
    const heard: unknown[] = [];
    store.onChange((sections) => heard.push(sections));

    store.save([BETA, ALPHA]);

    const written: unknown = JSON.parse(fs.readFileSync(index, 'utf8'));
    expect(written).toStrictEqual({ schemaVersion: 1, packs: [ALPHA, BETA] });
    expect(packIndexFileSchema.safeParse(written).success).toBe(true);
    expect(tree()).toStrictEqual(['index.json']);
    expect(store.list()).toStrictEqual([ALPHA, BETA]);
    expect(heard).toStrictEqual([
      { packs: { installed: [staged(ALPHA), staged(BETA)] } },
    ]);
    expect(store.get()).toBe(heard[0]);
  });

  it('a later load reads what save wrote', () => {
    load().save([ALPHA]);
    makeFolders('alpha-pack/1.2.0');

    expect(load().list()).toStrictEqual([ALPHA]);
  });

  it('throws on entries that fail the schema, writing and changing nothing', () => {
    const store = load();
    const listener = vi.fn();
    store.onChange(listener);

    expect(() => store.save([ALPHA, { ...ALPHA }])).toThrow();
    expect(() =>
      store.save([{ ...ALPHA, servedPaths: ['a/../b.js'] }]),
    ).toThrow();

    expect(fs.existsSync(index)).toBe(false);
    expect(store.list()).toStrictEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('throws when the write fails, leaving the old index.json, the entries and the listeners as they were', () => {
    writeIndex({ schemaVersion: 1, packs: [ALPHA] });
    makeFolders('alpha-pack/1.2.0');
    const store = load({
      fs: fsWith({
        writeFileSync: failWith('ENOSPC') as PacksFs['writeFileSync'],
      }),
    });
    const listener = vi.fn();
    store.onChange(listener);

    expect(() => store.save([ALPHA, BETA])).toThrow(/ENOSPC/);

    expect(JSON.parse(fs.readFileSync(index, 'utf8'))).toStrictEqual({
      schemaVersion: 1,
      packs: [ALPHA],
    });
    expect(tree()).not.toContain('index.json.tmp');
    expect(store.list()).toStrictEqual([ALPHA]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('a listener that throws is logged and the others still hear the change', () => {
    const store = load();
    const later = vi.fn();
    store.onChange(() => {
      throw new TypeError('boom');
    });
    store.onChange(later);

    store.save([ALPHA]);

    expect(later).toHaveBeenCalledTimes(1);
    expect(packsLines('error')).toStrictEqual([
      '[packs] a change listener failed (TypeError)',
    ]);
  });

  it('stops telling a listener once it unsubscribes', () => {
    const store = load();
    const listener = vi.fn();
    const unsubscribe = store.onChange(listener);

    unsubscribe();
    store.save([ALPHA]);

    expect(listener).not.toHaveBeenCalled();
  });
});
