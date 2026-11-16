/**
 * main/packs removal (Story 3.3's second half): the contract test pack (and
 * a copy of it under another id) installed into a packs folder in a temp
 * folder, then removed with removePack: index.json first, then the folder,
 * StageView's packs section, settings.json left alone, and what happens
 * when a step fails or a replace is waiting for the same pack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPackImporter } from '../../src/main/packs/importer';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { removePack, type PackRemoveFs } from '../../src/main/packs/remove';
import {
  loadPacks,
  type PacksFs,
  type PacksStore,
} from '../../src/main/packs/store';
import {
  loadSettings,
  type SettingsStore,
} from '../../src/main/settings/store';
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

const OTHER_ID = 'other-pack';

let root: string;
let dir: string;
let settings: SettingsStore | undefined;

beforeEach(() => {
  fake.resetFakeElectron();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-remove-'));
  dir = path.join(root, 'packs');
  settings = undefined;
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  settings?.flushSync();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function packsLines(level: 'info' | 'warn' | 'error'): string[] {
  return vi
    .mocked(console[level])
    .mock.calls.map((call: unknown[]) => String(call[0]))
    .filter((line) => line.startsWith('[packs] '));
}

/** The contract pack as `packId` at `version`, as a .awpet; answers its path. */
async function awpet(packId = CONTRACT_PACK_ID, version = '1.0.0') {
  const files: Map<string, Buffer | string> = contractPackFiles();
  const manifest = contractManifest();
  manifest.id = packId;
  manifest.version = version;
  files.set('manifest.json', manifestBytes(manifest));
  const at = path.join(root, `${packId}-${version}.awpet`);
  fs.writeFileSync(at, await zipBuffer(itemsOf(files, packId)));
  return at;
}

/** Installs the contract pack as `packId` at `version` into `store`. */
async function install(
  store: PacksStore,
  packId = CONTRACT_PACK_ID,
  version = '1.0.0',
): Promise<void> {
  const inspection = await inspectPack(await awpet(packId, version), store);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  const result = installPack(store, inspection.plan);
  if (!result.ok) {
    throw new Error(result.code);
  }
}

/** A packs folder with the contract pack and OTHER_ID installed. */
async function twoInstalled(fsImpl?: PacksFs): Promise<PacksStore> {
  const store = loadPacks({
    dir,
    ...(fsImpl === undefined ? {} : { fs: fsImpl }),
  });
  await install(store);
  await install(store, OTHER_ID, '2.0.0');
  return store;
}

function indexText(): string {
  return fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
}

function indexIds(): string[] {
  const index = JSON.parse(indexText()) as { packs: { id: string }[] };
  return index.packs.map((pack) => pack.id);
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Node's fs as the store uses it, with writeFileSync failing from now on when `failing` says so. */
function storeFs(failing: { write: boolean }): PacksFs {
  return {
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    readdirSync: (at, options) => fs.readdirSync(at, options),
    rmSync: (target, options) => {
      fs.rmSync(target, options);
    },
    writeFileSync: (file, data, options) => {
      if (failing.write) {
        throw failure('ENOSPC');
      }
      fs.writeFileSync(file, data, options);
    },
    renameSync: (from, to) => {
      fs.renameSync(from, to);
    },
    unlinkSync: (file) => {
      fs.unlinkSync(file);
    },
    mkdirSync: (at, options) => fs.mkdirSync(at, options),
    existsSync: (target) => fs.existsSync(target),
  };
}

/** StageView over `store` and a settings.json in the temp folder. */
function stageViewOf(store: PacksStore) {
  settings = loadSettings({ file: path.join(root, 'settings.json') });
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
  return { hub, deltas: () => subscriber.sent.map(({ args }) => args[0]) };
}

describe('I/O matrix', () => {
  it("移除: index.json loses the pack, then its folder goes; StageView's list loses that row; the other pack stays", async () => {
    const store = await twoInstalled();
    const { hub, deltas } = stageViewOf(store);

    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });

    expect(indexIds()).toStrictEqual([OTHER_ID]);
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID))).toBe(false);
    expect(fs.existsSync(path.join(dir, OTHER_ID, '2.0.0'))).toBe(true);
    expect(store.find(CONTRACT_PACK_ID)).toBeUndefined();
    expect(hub.snapshot().view.packs.installed.map((p) => p.id)).toStrictEqual([
      OTHER_ID,
    ]);
    expect(deltas()).toHaveLength(1);
    expect(stageViewDeltaSchema.safeParse(deltas()[0]).success).toBe(true);
    expect(packsLines('info')).toContain(
      `[packs] removed pack ${CONTRACT_PACK_ID}`,
    );
  });

  it("移除: settings.json keeps the pack's 上場 and each character's 加入池子 values, untouched", async () => {
    const store = await twoInstalled();
    const { hub } = stageViewOf(store);
    const kept = settings?.patch({
      baseRev: 0,
      ops: [
        { op: 'setPackEnabled', packId: CONTRACT_PACK_ID, value: false },
        {
          op: 'setFixed',
          characterKey: `${CONTRACT_PACK_ID}/probe-one`,
          param: 'inPool',
          value: false,
        },
      ],
    });
    expect(kept?.saved).toBe(true);
    settings?.flushSync();
    const file = path.join(root, 'settings.json');
    const before = fs.readFileSync(file, 'utf8');
    const values = hub.snapshot().view.settings;

    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });
    settings?.flushSync();

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(hub.snapshot().view.settings).toStrictEqual(values);
    expect(values.values.packEnabled).toStrictEqual({
      [CONTRACT_PACK_ID]: false,
    });
  });

  it('刪資料夾失敗: index.json is written, the folder stays; still gone from the list, with one error line; the next start removes the folder', async () => {
    const store = await twoInstalled();
    const { hub } = stageViewOf(store);
    const rmFails: PackRemoveFs = {
      rmSync: () => {
        throw failure('EBUSY');
      },
    };

    expect(removePack(store, CONTRACT_PACK_ID, { fs: rmFails })).toStrictEqual({
      ok: true,
    });

    expect(indexIds()).toStrictEqual([OTHER_ID]);
    expect(hub.snapshot().view.packs.installed.map((p) => p.id)).toStrictEqual([
      OTHER_ID,
    ]);
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID))).toBe(true);
    expect(packsLines('error')).toStrictEqual([
      `[packs] pack ${CONTRACT_PACK_ID}: removed from the list, but its folder could not be removed (EBUSY); the next start removes it`,
    ]);

    const next = loadPacks({ dir });
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID))).toBe(false);
    expect(next.list().map((entry) => entry.id)).toStrictEqual([OTHER_ID]);
  });

  it('移除失敗: index.json not written this run is index-unwritable; the list and the files are as they were', async () => {
    const store = await twoInstalled();
    const before = indexText();
    const rmSync = vi.fn();
    const unwritable = {
      dir: store.dir,
      canWrite: false,
      find: store.find,
      list: store.list,
      save: store.save,
    };

    expect(
      removePack(unwritable, CONTRACT_PACK_ID, { fs: { rmSync } }),
    ).toStrictEqual({ ok: false, code: 'index-unwritable' });

    expect(indexText()).toBe(before);
    expect(rmSync).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0'))).toBe(true);
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not remove pack ${CONTRACT_PACK_ID}: index-unwritable`,
    ]);
  });

  it('移除失敗: a write of index.json that fails is index-write-failed; the list, index.json and the files are as they were', async () => {
    const failing = { write: false };
    const store = await twoInstalled(storeFs(failing));
    const { hub, deltas } = stageViewOf(store);
    const before = indexText();
    failing.write = true;

    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({
      ok: false,
      code: 'index-write-failed',
    });

    expect(indexText()).toBe(before);
    expect(store.find(CONTRACT_PACK_ID)).toBeDefined();
    expect(hub.snapshot().view.packs.installed.map((p) => p.id)).toStrictEqual([
      CONTRACT_PACK_ID,
      OTHER_ID,
    ]);
    expect(deltas()).toStrictEqual([]);
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0'))).toBe(true);
    expect(packsLines('error')).toStrictEqual([
      `[packs] could not remove pack ${CONTRACT_PACK_ID}: index-write-failed (ENOSPC)`,
    ]);
  });

  it('已不在: a pack id not installed is not-installed, and nothing changes', async () => {
    const store = await twoInstalled();
    const { deltas } = stageViewOf(store);
    const before = indexText();
    const rmSync = vi.fn();

    expect(removePack(store, 'gone-pack', { fs: { rmSync } })).toStrictEqual({
      ok: false,
      code: 'not-installed',
    });

    expect(indexText()).toBe(before);
    expect(rmSync).not.toHaveBeenCalled();
    expect(deltas()).toStrictEqual([]);
    expect(packsLines('warn')).toStrictEqual([
      '[packs] could not remove pack gone-pack: not-installed',
    ]);
  });

  it('已不在: removing the same pack twice: the second time is not-installed', async () => {
    const store = await twoInstalled();

    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });
    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({
      ok: false,
      code: 'not-installed',
    });
    expect(indexIds()).toStrictEqual([OTHER_ID]);
  });

  it.each([['..'], ['.'], [''], ['index.json'], ['Other-Pack'], ['a/b']])(
    '壞輸入: %j, not a pack id, is not-installed and touches nothing',
    async (packId) => {
      const store = await twoInstalled();
      const before = indexText();
      const rmSync = vi.fn();

      expect(removePack(store, packId, { fs: { rmSync } })).toStrictEqual({
        ok: false,
        code: 'not-installed',
      });
      expect(rmSync).not.toHaveBeenCalled();
      expect(indexText()).toBe(before);
    },
  );

  it('移除: only packs/<packId>/ goes, every version folder in it included', async () => {
    const store = await twoInstalled();
    // A version folder index.json does not point to (left behind).
    fs.mkdirSync(path.join(dir, CONTRACT_PACK_ID, '0.9.0'));
    const rmSync = vi.fn((target: string) => {
      fs.rmSync(target, { recursive: true, force: true });
    });

    removePack(store, CONTRACT_PACK_ID, { fs: { rmSync } });

    expect(rmSync).toHaveBeenCalledExactlyOnceWith(
      path.join(dir, CONTRACT_PACK_ID),
      { recursive: true, force: true },
    );
    expect(fs.readdirSync(dir).sort()).toStrictEqual(['index.json', OTHER_ID]);
  });

  it('等待取代時移除: while the importer waits to replace the pack, it is removed anyway; 取代 then installs as stale-plan', async () => {
    const store = loadPacks({ dir });
    const importer = createPackImporter({
      store,
      inspect: inspectPack,
      install: installPack,
      chooseFile: async () => null,
    });
    await importer.start(await awpet(CONTRACT_PACK_ID, '1.0.0'));
    await importer.start(await awpet(CONTRACT_PACK_ID, '1.1.0'));
    expect(importer.get().packImport).toMatchObject({
      phase: 'confirm',
      previous: { version: '1.0.0' },
    });

    expect(removePack(store, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });
    importer.confirm(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(importer.get().packImport).toStrictEqual({
      phase: 'result',
      outcome: 'failed',
      code: 'stale-plan',
    });
    expect(store.list()).toStrictEqual([]);
    expect(fs.existsSync(path.join(dir, CONTRACT_PACK_ID))).toBe(false);
  });

  it('logs codes and the pack id only, never a path', async () => {
    const store = await twoInstalled();
    removePack(store, CONTRACT_PACK_ID, {
      fs: {
        rmSync: () => {
          throw failure('EPERM');
        },
      },
    });
    removePack(store, 'gone-pack');

    for (const line of [
      ...packsLines('info'),
      ...packsLines('warn'),
      ...packsLines('error'),
    ]) {
      expect(line).not.toContain(root);
    }
  });
});
