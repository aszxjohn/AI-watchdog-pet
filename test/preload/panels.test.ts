import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDetection } from '../../src/main/detection/detection';
import { registerIpcHandler } from '../../src/main/ipc/register';
import { exportPack } from '../../src/main/packs/export';
import { createPackExporter } from '../../src/main/packs/exporter';
import { createPackImporter } from '../../src/main/packs/importer';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { registerPackHandlers } from '../../src/main/packs/ipc';
import { removePack } from '../../src/main/packs/remove';
import { loadPacks } from '../../src/main/packs/store';
import { registerPoolHandlers } from '../../src/main/pool/ipc';
import { loadPool, type PoolStore } from '../../src/main/pool/store';
import { registerSettingsHandlers } from '../../src/main/settings/ipc';
import {
  loadSettings,
  type SettingsStore,
} from '../../src/main/settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from '../../src/main/stage-view/stage-view';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import { appGetVersion } from '../../src/shared/ipc';
import type { PanelsApi } from '../../src/shared/preload-api';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
import {
  CONTRACT_PACK_ID,
  contractPackFiles,
  itemsOf,
  zipBuffer,
} from '../helpers/awpet';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let dir: string;
let settings: SettingsStore | undefined;
let pool: PoolStore | undefined;

beforeEach(() => {
  fake.resetFakeElectron();
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-panels-'));
  settings = undefined;
  pool = undefined;
});

afterEach(() => {
  settings?.flushSync();
  pool?.flushSync();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function loadApi(): Promise<PanelsApi> {
  await import('../../src/preload/panels');
  return fake.exposed.get('awp') as PanelsApi;
}

/**
 * main as main.ts wires it, with settings.json, assignments.json and the
 * packs folder in a temp folder. The file dialog is `chooseFile` and the
 * save dialog `chooseTarget` (both cancelled by default).
 */
function startMain(
  chooseFile: () => Promise<string | null> = async () => null,
  chooseTarget: (defaultName: string) => Promise<string | null> = async () =>
    null,
): SettingsStore {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  settings = loadSettings({ file: path.join(dir, 'settings.json') });
  const detection = createDetection({ settings });
  pool = loadPool({ file: path.join(dir, 'assignments.json') });
  const packs = loadPacks({ dir: path.join(dir, 'packs') });
  const packImport = createPackImporter({
    store: packs,
    inspect: inspectPack,
    install: installPack,
    chooseFile,
  });
  const packExport = createPackExporter({
    store: packs,
    exportPack,
    chooseTarget,
  });
  registerSettingsHandlers(settings);
  registerPoolHandlers(pool);
  registerPackHandlers(packImport, packExport, (packId) =>
    removePack(packs, packId),
  );
  registerStageViewHandlers(
    createStageView({
      settings,
      windows: createWindowsStageSource(),
      detection,
      pool,
      packs,
      packImport,
      packExport,
    }),
  );
  return settings;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('panels preload', () => {
  it('exposes only window.awp, frozen', async () => {
    const api = await loadApi();

    expect([...fake.exposed.keys()]).toStrictEqual(['awp']);
    expect(Object.keys(api).sort()).toStrictEqual([
      'app',
      'packs',
      'pool',
      'settings',
      'stageView',
    ]);
    expect(Object.keys(api.pool)).toStrictEqual(['setReleased']);
    expect(Object.keys(api.packs)).toStrictEqual([
      'choose',
      'confirm',
      'export',
      'remove',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.pool)).toBe(true);
    expect(Object.isFrozen(api.packs)).toBe(true);
    expect(Object.isFrozen(api.settings)).toBe(true);
    expect(Object.isFrozen(api.stageView)).toBe(true);
  });

  it('app.getVersion() resolves with { ok: true, data } from main', async () => {
    registerIpcHandler(appGetVersion, ['panels'], () => '1.2.3');
    const api = await loadApi();

    expect(await api.app.getVersion()).toStrictEqual({
      ok: true,
      data: '1.2.3',
    });
  });

  it('settings.get() resolves with the values and their rev', async () => {
    startMain();
    const api = await loadApi();

    expect(await api.settings.get()).toStrictEqual({
      ok: true,
      data: { rev: 0, values: SETTINGS_DEFAULTS },
    });
  });

  it('a settings.patch reaches a StageView listener: new value, rev + 1, matching settings rev', async () => {
    startMain();
    const api = await loadApi();
    const listener = vi.fn<(snapshot: StageViewSnapshot) => void>();
    api.stageView.subscribe(listener);
    await settle();
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      rev: 0,
      view: {
        settings: { rev: 0, values: SETTINGS_DEFAULTS },
        displays: [],
        canvas: null,
        power: { suspended: false, locked: false },
        sessions: [],
        adapters: [],
        pool: { released: [] },
        packs: { installed: [] },
        packImport: { phase: 'idle' },
        packExport: { phase: 'idle' },
      },
    });

    const result = await api.settings.patch({
      baseRev: 0,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: 69733632 }],
    });
    await settle();

    expect(result).toStrictEqual({
      ok: true,
      data: { rev: 1, merged: false, saved: true },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    const latest = listener.mock.lastCall?.[0];
    expect(latest?.rev).toBe(1);
    expect(latest?.view.settings.values.canvasDisplayId).toBe(69733632);
    const patchedRev = result.ok ? result.data.rev : undefined;
    expect(latest?.view.settings.rev).toBe(patchedRev);
  });

  it('settings.patch answers invalid-input to a bad patch and nothing changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startMain();
    const api = await loadApi();
    const listener = vi.fn();
    api.stageView.subscribe(listener);
    await settle();

    const result = await api.settings.patch({
      baseRev: 0,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: -1 }],
    });
    await settle();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('a pool.setReleased reaches a StageView listener through the pool section, and showing again removes it', async () => {
    startMain();
    const api = await loadApi();
    const listener = vi.fn<(snapshot: StageViewSnapshot) => void>();
    api.stageView.subscribe(listener);
    await settle();

    const released = await api.pool.setReleased('demo:1', true);
    await settle();

    expect(released).toStrictEqual({ ok: true, data: null });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      rev: 1,
      view: { pool: { released: ['demo:1'] } },
    });

    // Releasing it again changes nothing: success, no delta.
    expect(await api.pool.setReleased('demo:1', true)).toStrictEqual({
      ok: true,
      data: null,
    });
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);

    expect(await api.pool.setReleased('demo:1', false)).toStrictEqual({
      ok: true,
      data: null,
    });
    await settle();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      rev: 2,
      view: { pool: { released: [] } },
    });
  });

  it('pool.setReleased answers invalid-input to a bad key and nothing changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startMain();
    const api = await loadApi();
    const listener = vi.fn();
    api.stageView.subscribe(listener);
    await settle();

    const result = await api.pool.setReleased(
      'vim:1' as unknown as 'demo:1',
      true,
    );
    await settle();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(pool?.get()).toStrictEqual({ pool: { released: [] } });
  });

  it('a packs.choose answers null at once; StageView shows reading while the dialog is open, and the phase before once it is cancelled', async () => {
    let close: (file: string | null) => void = () => {};
    startMain(
      () =>
        new Promise<string | null>((resolve) => {
          close = resolve;
        }),
    );
    const api = await loadApi();
    const listener = vi.fn<(snapshot: StageViewSnapshot) => void>();
    api.stageView.subscribe(listener);
    await settle();

    expect(await api.packs.choose()).toStrictEqual({ ok: true, data: null });
    await settle();
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      rev: 1,
      view: { packImport: { phase: 'reading' } },
    });

    close(null);
    await settle();
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      rev: 2,
      view: { packImport: { phase: 'idle' } },
    });
  });

  it('packs.confirm answers null, and nothing changes when no pack waits for confirmation', async () => {
    startMain();
    const api = await loadApi();
    const listener = vi.fn();
    api.stageView.subscribe(listener);
    await settle();

    expect(await api.packs.confirm(true)).toStrictEqual({
      ok: true,
      data: null,
    });
    await settle();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('packs.confirm answers invalid-input to a flag that is not a boolean, and nothing changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startMain();
    const api = await loadApi();
    const listener = vi.fn();
    api.stageView.subscribe(listener);
    await settle();

    const result = await api.packs.confirm('yes' as unknown as boolean);
    await settle();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(listener).toHaveBeenCalledOnce();
  });
  it('packs.export answers null at once; StageView shows saving while the save dialog is open, and the phase before once it is cancelled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let close: (target: string | null) => void = () => {};
    const awpet = path.join(dir, 'pack.awpet');
    fs.writeFileSync(awpet, await zipBuffer(itemsOf(contractPackFiles())));
    startMain(
      async () => awpet,
      () =>
        new Promise<string | null>((resolve) => {
          close = resolve;
        }),
    );
    const api = await loadApi();
    expect(await api.packs.choose()).toStrictEqual({ ok: true, data: null });
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(dir, 'packs', 'index.json'))).toBe(true);
    });
    const listener = vi.fn<(snapshot: StageViewSnapshot) => void>();
    api.stageView.subscribe(listener);
    await settle();
    const before = listener.mock.lastCall?.[0];
    expect(before?.view.packExport).toStrictEqual({ phase: 'idle' });

    expect(await api.packs.export(CONTRACT_PACK_ID)).toStrictEqual({
      ok: true,
      data: null,
    });
    await settle();
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      rev: (before?.rev ?? 0) + 1,
      view: { packExport: { phase: 'saving', packId: CONTRACT_PACK_ID } },
    });

    close(null);
    await settle();
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      rev: (before?.rev ?? 0) + 2,
      view: { packExport: { phase: 'idle' } },
    });
  });

  it('packs.export then packs.remove: the pack is written where the save dialog says, then removed from StageView', async () => {
    const awpet = path.join(dir, 'pack.awpet');
    const target = path.join(dir, 'exported.awpet');
    fs.writeFileSync(awpet, await zipBuffer(itemsOf(contractPackFiles())));
    startMain(
      async () => awpet,
      async () => target,
    );
    const api = await loadApi();
    await api.packs.choose();
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(dir, 'packs', 'index.json'))).toBe(true);
    });
    const listener = vi.fn<(snapshot: StageViewSnapshot) => void>();
    api.stageView.subscribe(listener);
    await settle();

    await api.packs.export(CONTRACT_PACK_ID);
    await vi.waitFor(() => {
      expect(listener.mock.lastCall?.[0].view.packExport).toMatchObject({
        phase: 'result',
        outcome: 'exported',
      });
    });
    expect(fs.existsSync(target)).toBe(true);

    expect(await api.packs.remove(CONTRACT_PACK_ID)).toStrictEqual({
      ok: true,
      data: { ok: true },
    });
    await settle();
    expect(listener.mock.lastCall?.[0].view.packs).toStrictEqual({
      installed: [],
    });
    expect(fs.existsSync(path.join(dir, 'packs', CONTRACT_PACK_ID))).toBe(
      false,
    );
  });

  it('packs.remove of a pack not installed answers not-installed, and nothing changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startMain();
    const api = await loadApi();
    const listener = vi.fn();
    api.stageView.subscribe(listener);
    await settle();

    expect(await api.packs.remove('sample-pack')).toStrictEqual({
      ok: true,
      data: { ok: false, code: 'not-installed' },
    });
    await settle();
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([
    ['packs.export', (api: PanelsApi) => api.packs.export('Bad Id')],
    ['packs.remove', (api: PanelsApi) => api.packs.remove('../packs')],
  ])(
    '%s answers invalid-input to an id that is not a pack id, and nothing changes',
    async (_label, call) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      startMain();
      const api = await loadApi();
      const listener = vi.fn();
      api.stageView.subscribe(listener);
      await settle();

      expect(await call(api)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      await settle();
      expect(listener).toHaveBeenCalledOnce();
    },
  );
});
