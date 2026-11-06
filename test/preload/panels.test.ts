import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandler } from '../../src/main/ipc/register';
import { registerSettingsHandlers } from '../../src/main/settings/ipc';
import {
  loadSettings,
  type SettingsStore,
} from '../../src/main/settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from '../../src/main/stage-view/stage-view';
import { appGetVersion } from '../../src/shared/ipc';
import type { PanelsApi } from '../../src/shared/preload-api';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let dir: string;
let settings: SettingsStore | undefined;

beforeEach(() => {
  fake.resetFakeElectron();
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-panels-'));
  settings = undefined;
});

afterEach(() => {
  settings?.flushSync();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function loadApi(): Promise<PanelsApi> {
  await import('../../src/preload/panels');
  return fake.exposed.get('awp') as PanelsApi;
}

/** main as main.ts wires it, with settings.json in a temp folder. */
function startMain(): SettingsStore {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  settings = loadSettings({ file: path.join(dir, 'settings.json') });
  registerSettingsHandlers(settings);
  registerStageViewHandlers(createStageView({ settings }));
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
      'settings',
      'stageView',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.settings)).toBe(true);
    expect(Object.isFrozen(api.stageView)).toBe(true);
  });

  it('app.getVersion() resolves with { ok: true, data } from main', async () => {
    registerIpcHandler(appGetVersion, () => '1.2.3');
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
      view: { settings: { rev: 0, values: SETTINGS_DEFAULTS } },
    });

    const result = await api.settings.patch({
      baseRev: 0,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: 69733632 }],
    });
    await settle();

    expect(result).toStrictEqual({ ok: true, data: { rev: 1, merged: false } });
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
});
