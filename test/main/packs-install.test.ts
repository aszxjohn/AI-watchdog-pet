/**
 * main/packs install (Story 3.2): a plan from inspect.ts (the contract test
 * pack zipped with yazl) installed into a packs folder in a temp folder:
 * the temporary folder, the replace, index.json, StageView's packs
 * section, and putting everything back when a step fails.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectPack,
  type PackInstallPlan,
} from '../../src/main/packs/inspect';
import { installPack, type PackInstallFs } from '../../src/main/packs/install';
import {
  loadPacks,
  type PacksFs,
  type PacksStore,
} from '../../src/main/packs/store';
import { loadSettings } from '../../src/main/settings/store';
import { createStageView } from '../../src/main/stage-view/stage-view';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import { stageViewDeltaSchema } from '../../src/shared/stage-view';
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
let tokens: number;

beforeEach(() => {
  fake.resetFakeElectron();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-install-'));
  dir = path.join(root, 'packs');
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

/** A plan for the contract pack at `version`, with `extra` files added. */
async function planFor(
  version = '1.0.0',
  extra: Record<string, string> = {},
  store?: PacksStore,
): Promise<PackInstallPlan> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  const manifest = contractManifest();
  manifest.version = version;
  files.set('manifest.json', manifestBytes(manifest));
  for (const [name, data] of Object.entries(extra)) {
    files.set(name, data);
  }
  const awpet = path.join(root, `pack-${version}.awpet`);
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
  const inspection = await inspectPack(
    awpet,
    store ?? { find: () => undefined },
  );
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  return inspection.plan;
}

/** Predictable temporary folder names: .staging-t1, .backup-t1, … */
function token(): string {
  tokens += 1;
  return `t${tokens}`;
}

function install(
  store: PacksStore,
  plan: PackInstallPlan,
  fsImpl?: PackInstallFs,
) {
  return installPack(store, plan, {
    token,
    ...(fsImpl === undefined ? {} : { fs: fsImpl }),
  });
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

/** The contract pack's files as installed at `version`, `/`-separated. */
function installedTree(version: string, extra: string[] = []): string[] {
  const at = `${CONTRACT_PACK_ID}/${version}`;
  const files = [...contractPackFiles().keys(), ...extra];
  const folders = new Set<string>([CONTRACT_PACK_ID, at]);
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      folders.add(`${at}/${parts.slice(0, i).join('/')}`);
    }
  }
  return [
    ...folders,
    ...files.map((file) => `${at}/${file}`),
    'index.json',
  ].sort();
}

function readIndex(): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
}

function installedFile(version: string, file: string): string {
  return fs.readFileSync(
    path.join(dir, CONTRACT_PACK_ID, version, file),
    'utf8',
  );
}

function installFsWith(overrides: Partial<PackInstallFs>): PackInstallFs {
  return { ...fs, ...overrides } as unknown as PackInstallFs;
}

function failing(code: string) {
  return Object.assign(new Error(`${code}: somewhere`), { code });
}

describe('I/O matrix', () => {
  it('安裝: unpacks to a temporary folder, moves it to packs/<packId>/<version>/, writes index.json, publishes the packs section; nothing temporary is left', async () => {
    const store = loadPacks({ dir });
    const plan = await planFor();
    const heard: unknown[] = [];
    store.onChange((sections) => heard.push(sections));

    const result = install(store, plan);

    expect(result).toStrictEqual({
      ok: true,
      packId: CONTRACT_PACK_ID,
      version: '1.0.0',
    });
    expect(tree()).toStrictEqual(installedTree('1.0.0'));
    for (const [name, data] of plan.files) {
      expect(
        fs
          .readFileSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0', name))
          .equals(data),
        name,
      ).toBe(true);
    }
    expect(readIndex()).toStrictEqual({
      schemaVersion: 1,
      packs: [plan.index],
    });
    expect(store.list()).toStrictEqual([plan.index]);
    const { servedPaths: _served, ...staged } = plan.index;
    expect(heard).toStrictEqual([{ packs: { installed: [staged] } }]);
    expect(packsLines('info')).toContain(
      `[packs] installed pack ${CONTRACT_PACK_ID} (7 files)`,
    );
  });

  it('安裝: StageView carries the new packs section in its next delta', async () => {
    const store = loadPacks({ dir });
    const settings = loadSettings({ file: path.join(root, 'settings.json') });
    const hub = createStageView({
      settings,
      windows: createWindowsStageSource(),
      detection: {
        get: () => ({ sessions: [], adapters: [] }),
        onChange: () => () => {},
      },
      pool: {
        get: () => ({ pool: { released: [] } }),
        onChange: () => () => {},
      },
      packs: store,
      packImport: {
        get: () => ({ packImport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
      packExport: {
        get: () => ({ packExport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
    });
    const subscriber = fake.createFakeWebContents(
      1,
      'app://panels/index.html',
      false,
    );
    hub.subscribe(subscriber);
    const plan = await planFor();

    install(store, plan);

    const { servedPaths: _served, ...staged } = plan.index;
    expect(subscriber.sent.map(({ args }) => args[0])).toStrictEqual([
      { rev: 1, sections: { packs: { installed: [staged] } } },
    ]);
    expect(
      stageViewDeltaSchema.safeParse(subscriber.sent[0]?.args[0]).success,
    ).toBe(true);
    expect(hub.snapshot().view.packs).toStrictEqual({ installed: [staged] });
  });

  it('安裝: another version replaces the installed one; the old folder is removed and index.json keeps one entry for the pack', async () => {
    const store = loadPacks({ dir });
    install(store, await planFor('1.0.0'));
    const update = await planFor('1.1.0', { 'notes.txt': 'new' }, store);
    expect(update.previous).toStrictEqual({
      name: '契約測試包',
      version: '1.0.0',
    });

    const result = install(store, update);

    expect(result.ok).toBe(true);
    expect(tree()).toStrictEqual(installedTree('1.1.0', ['notes.txt']));
    expect(readIndex()).toStrictEqual({
      schemaVersion: 1,
      packs: [update.index],
    });
    expect(packsLines('info')).toContain(
      `[packs] installed pack ${CONTRACT_PACK_ID} (8 files, replacing the installed version)`,
    );
  });

  it('安裝: a downgrade installs the same way once handed over', async () => {
    const store = loadPacks({ dir });
    install(store, await planFor('2.0.0'));
    const older = await planFor('1.0.0', {}, store);
    expect(older.downgrade).toBe(true);

    expect(install(store, older).ok).toBe(true);
    expect(tree()).toStrictEqual(installedTree('1.0.0'));
  });

  it('安裝: the same version again replaces its files through a backup that is removed afterwards', async () => {
    const store = loadPacks({ dir });
    install(store, await planFor('1.0.0', { 'notes.txt': 'old' }));

    const result = install(
      store,
      await planFor('1.0.0', { 'notes.txt': 'new' }, store),
    );

    expect(result.ok).toBe(true);
    expect(installedFile('1.0.0', 'notes.txt')).toBe('new');
    expect(tree()).toStrictEqual(installedTree('1.0.0', ['notes.txt']));
  });

  it('安裝: a folder left at the target that index.json does not point to is replaced', async () => {
    const store = loadPacks({ dir });
    // Made after the start-up cleanup, which would have removed it.
    fs.mkdirSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0', 'stale'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, CONTRACT_PACK_ID, '1.0.0', 'stale', 'x'),
      'x',
    );

    const result = install(store, await planFor());

    expect(result.ok).toBe(true);
    expect(tree()).toStrictEqual(installedTree('1.0.0'));
  });

  it('安裝失敗: a failing write to the temporary folder: extract-failed, the temporary folder removed, nothing else touched', async () => {
    const store = loadPacks({ dir });
    install(store, await planFor('1.0.0'));
    let writes = 0;
    const fsImpl = installFsWith({
      writeFileSync: ((
        file: string,
        data: Uint8Array,
        options: { flush: true },
      ) => {
        writes += 1;
        if (writes === 3) {
          throw failing('ENOSPC');
        }
        fs.writeFileSync(file, data, options);
      }) as PackInstallFs['writeFileSync'],
    });

    const result = install(store, await planFor('1.1.0', {}, store), fsImpl);

    expect(result).toStrictEqual({ ok: false, code: 'extract-failed' });
    expect(tree()).toStrictEqual(installedTree('1.0.0'));
    expect(store.list().map((entry) => entry.version)).toStrictEqual(['1.0.0']);
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not install pack ${CONTRACT_PACK_ID}: extract-failed (ENOSPC)`,
    ]);
  });

  it.each([
    ['a new pack', undefined],
    ['another version', '0.9.0'],
  ] as const)(
    '安裝失敗: a failing replace of %s: replace-failed, the old folder and index.json as they were, nothing temporary left',
    async (_label, before) => {
      const store = loadPacks({ dir });
      if (before !== undefined) {
        install(store, await planFor(before));
      }
      const treeBefore = tree();
      const indexBefore = fs.existsSync(path.join(dir, 'index.json'))
        ? readIndex()
        : undefined;
      const listener = vi.fn();
      store.onChange(listener);
      const fsImpl = installFsWith({
        renameSync: ((from: string, to: string) => {
          if (path.basename(from).startsWith('.staging-')) {
            throw failing('EPERM');
          }
          fs.renameSync(from, to);
        }) as PackInstallFs['renameSync'],
      });

      const result = install(store, await planFor('1.0.0', {}, store), fsImpl);

      expect(result).toStrictEqual({ ok: false, code: 'replace-failed' });
      // The new pack's empty folder may stay: the next start removes it.
      expect(
        tree().filter((entry) => entry !== CONTRACT_PACK_ID),
      ).toStrictEqual(treeBefore.filter((entry) => entry !== CONTRACT_PACK_ID));
      expect(
        fs.existsSync(path.join(dir, 'index.json')) ? readIndex() : undefined,
      ).toStrictEqual(indexBefore);
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it('安裝失敗: a failing replace of the same version: the backup goes back in place', async () => {
    const store = loadPacks({ dir });
    install(store, await planFor('1.0.0', { 'notes.txt': 'old' }));
    const fsImpl = installFsWith({
      renameSync: ((from: string, to: string) => {
        if (path.basename(from).startsWith('.staging-')) {
          throw failing('EPERM');
        }
        fs.renameSync(from, to);
      }) as PackInstallFs['renameSync'],
    });

    const result = install(
      store,
      await planFor('1.0.0', { 'notes.txt': 'new' }, store),
      fsImpl,
    );

    expect(result).toStrictEqual({ ok: false, code: 'replace-failed' });
    expect(installedFile('1.0.0', 'notes.txt')).toBe('old');
    expect(tree()).toStrictEqual(installedTree('1.0.0', ['notes.txt']));
  });

  it.each([
    ['another version', '0.9.0', '1.0.0'],
    ['the same version', '1.0.0', '1.0.0'],
  ] as const)(
    '安裝失敗: a failing index.json write over %s: index-write-failed, the new folder removed, the old folder and index.json as they were',
    async (_label, before, version) => {
      let failIndex = false;
      const storeFs = {
        ...fs,
        writeFileSync: ((file: string, ...rest: unknown[]) => {
          if (failIndex && path.basename(file) === 'index.json.tmp') {
            throw failing('ENOSPC');
          }
          return (fs.writeFileSync as (...args: unknown[]) => void)(
            file,
            ...rest,
          );
        }) as PacksFs['writeFileSync'],
      } as unknown as PacksFs;
      const store = loadPacks({ dir, fs: storeFs });
      install(store, await planFor(before, { 'notes.txt': 'old' }));
      const treeBefore = tree();
      const indexBefore = readIndex();
      const listener = vi.fn();
      store.onChange(listener);
      failIndex = true;

      const result = install(
        store,
        await planFor(version, { 'notes.txt': 'new' }, store),
      );

      expect(result).toStrictEqual({ ok: false, code: 'index-write-failed' });
      expect(tree()).toStrictEqual(treeBefore);
      expect(installedFile(before, 'notes.txt')).toBe('old');
      expect(readIndex()).toStrictEqual(indexBefore);
      expect(store.list().map((entry) => entry.version)).toStrictEqual([
        before,
      ]);
      expect(listener).not.toHaveBeenCalled();
      expect(packsLines('error')).toStrictEqual([
        `[packs] could not install pack ${CONTRACT_PACK_ID}: index-write-failed (ENOSPC)`,
      ]);
    },
  );

  it('安裝失敗: a failing write whose temporary folder cannot be removed logs that too', async () => {
    const store = loadPacks({ dir });
    const fsImpl = installFsWith({
      writeFileSync: (() => {
        throw failing('ENOSPC');
      }) as PackInstallFs['writeFileSync'],
      rmSync: (() => {
        throw failing('EBUSY');
      }) as PackInstallFs['rmSync'],
    });

    const result = install(store, await planFor(), fsImpl);

    expect(result).toStrictEqual({ ok: false, code: 'extract-failed' });
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not remove pack ${CONTRACT_PACK_ID}'s temporary folder (EBUSY); the next start removes it`,
      `[packs] could not install pack ${CONTRACT_PACK_ID}: extract-failed (ENOSPC)`,
    ]);
  });

  it('安裝失敗: with removals failing too, a failed same-version replace still puts the old version back at its own path; the next start removes the rest', async () => {
    let failIndex = false;
    const storeFs = {
      ...fs,
      writeFileSync: ((file: string, ...rest: unknown[]) => {
        if (failIndex && path.basename(file) === 'index.json.tmp') {
          throw failing('ENOSPC');
        }
        return (fs.writeFileSync as (...args: unknown[]) => void)(
          file,
          ...rest,
        );
      }) as PacksFs['writeFileSync'],
    } as unknown as PacksFs;
    const store = loadPacks({ dir, fs: storeFs });
    install(store, await planFor('1.0.0', { 'notes.txt': 'old' }));
    failIndex = true;
    const fsImpl = installFsWith({
      rmSync: (() => {
        throw failing('EBUSY');
      }) as PackInstallFs['rmSync'],
    });

    const result = install(
      store,
      await planFor('1.0.0', { 'notes.txt': 'new' }, store),
      fsImpl,
    );

    expect(result).toStrictEqual({ ok: false, code: 'index-write-failed' });
    expect(installedFile('1.0.0', 'notes.txt')).toBe('old');
    expect(
      tree().filter((entry) => entry.startsWith('.backup-')),
    ).toStrictEqual([]);
    expect(tree()).toContain('.staging-t2-discard');

    const reloaded = loadPacks({ dir });

    expect(reloaded.find(CONTRACT_PACK_ID)?.version).toBe('1.0.0');
    expect(tree()).toStrictEqual(installedTree('1.0.0', ['notes.txt']));
    expect(installedFile('1.0.0', 'notes.txt')).toBe('old');
  });

  it('安裝失敗: a plan made before another install of the pack is stale-plan, and changes nothing', async () => {
    const store = loadPacks({ dir });
    const first = await planFor('1.0.0', {}, store);
    const second = await planFor('1.1.0', {}, store);
    expect(install(store, first).ok).toBe(true);
    const treeBefore = tree();

    const result = install(store, second);

    expect(result).toStrictEqual({ ok: false, code: 'stale-plan' });
    expect(tree()).toStrictEqual(treeBefore);
    expect(store.find(CONTRACT_PACK_ID)?.version).toBe('1.0.0');
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not install pack ${CONTRACT_PACK_ID}: stale-plan`,
    ]);
  });

  it('安裝失敗: a plan used once is stale-plan the second time', async () => {
    const store = loadPacks({ dir });
    const plan = await planFor('1.0.0', {}, store);

    expect(install(store, plan).ok).toBe(true);
    expect(install(store, plan)).toStrictEqual({
      ok: false,
      code: 'stale-plan',
    });
  });

  it('安裝失敗: a rollback step that fails is logged; the start-up cleanup removes the temporary folder', async () => {
    const store = loadPacks({ dir });
    const fsImpl = installFsWith({
      renameSync: (() => {
        throw failing('EPERM');
      }) as PackInstallFs['renameSync'],
      rmSync: (() => {
        throw failing('EBUSY');
      }) as PackInstallFs['rmSync'],
    });

    const result = install(store, await planFor(), fsImpl);

    expect(result).toStrictEqual({ ok: false, code: 'replace-failed' });
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not put pack ${CONTRACT_PACK_ID} back as it was (EBUSY)`,
      `[packs] could not install pack ${CONTRACT_PACK_ID}: replace-failed (EPERM)`,
    ]);
    expect(tree()).toContain('.staging-t1');

    loadPacks({ dir });

    // With no index.json yet, the empty pack folder stays (only an
    // index.json that was read says which pack folders are leftovers).
    expect(tree()).toStrictEqual([CONTRACT_PACK_ID]);
  });

  it('安裝失敗: with index.json unreadable at start: index-unwritable, nothing written', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      '{"schemaVersion": 1, "packs": []}',
    );
    const store = loadPacks({
      dir,
      fs: {
        ...fs,
        readFileSync: () => {
          throw failing('EACCES');
        },
      } as unknown as PacksFs,
    });

    const result = install(store, await planFor());

    expect(result).toStrictEqual({ ok: false, code: 'index-unwritable' });
    expect(tree()).toStrictEqual(['index.json']);
  });

  it('殘留: a replaced folder that cannot be removed is logged; the install counts, and the next start removes the folder', async () => {
    const store = loadPacks({ dir });
    install(store, await planFor('1.0.0'));
    const fsImpl = installFsWith({
      rmSync: ((target: string, options: { recursive: true; force: true }) => {
        if (path.basename(target) === '1.0.0') {
          throw failing('EBUSY');
        }
        fs.rmSync(target, options);
      }) as PackInstallFs['rmSync'],
    });

    const result = install(store, await planFor('1.1.0', {}, store), fsImpl);

    expect(result.ok).toBe(true);
    expect(tree()).toContain(`${CONTRACT_PACK_ID}/1.0.0`);
    expect(packsLines('warn')).toStrictEqual([
      `[packs] pack ${CONTRACT_PACK_ID}: could not remove the replaced folder (EBUSY); the next start removes it`,
    ]);

    const reloaded = loadPacks({ dir });

    expect(reloaded.find(CONTRACT_PACK_ID)?.version).toBe('1.1.0');
    expect(tree()).toStrictEqual(installedTree('1.1.0'));
  });
});
