import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSettingsHandlers } from '../../src/main/settings/ipc';
import {
  loadSettings,
  type SettingsStore,
} from '../../src/main/settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from '../../src/main/stage-view/stage-view';
import { registerCanvasReadyHandler } from '../../src/main/windows/canvas-window';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import { canvasReady, settingsPatch } from '../../src/shared/ipc';
import type { OverlayApi } from '../../src/shared/preload-api';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const OVERLAY_URL = 'app://overlay/index.html';
const CANVAS = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  fallback: false,
};

let dir: string;
let settings: SettingsStore | undefined;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.resetFakeElectron();
  vi.resetModules();
  fake.sender.mainFrame.url = OVERLAY_URL;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-overlay-'));
  settings = undefined;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  settings?.flushSync();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

async function loadApi(): Promise<OverlayApi> {
  await import('../../src/preload/overlay');
  return fake.exposed.get('awp') as OverlayApi;
}

/** main as main.ts wires it, with settings.json in a temp folder. */
function startMain() {
  settings = loadSettings({ file: path.join(dir, 'settings.json') });
  const windows = createWindowsStageSource();
  registerSettingsHandlers(settings);
  registerStageViewHandlers(createStageView({ settings, windows }));
  registerCanvasReadyHandler();
  return { settings, windows };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('overlay preload', () => {
  it('exposes only window.awp, frozen: stageView and canvas', async () => {
    const api = await loadApi();

    expect([...fake.exposed.keys()]).toStrictEqual(['awp']);
    expect(Object.keys(api).sort()).toStrictEqual(['canvas', 'stageView']);
    expect(Object.keys(api.canvas)).toStrictEqual(['ready']);
    expect(Object.keys(api.stageView)).toStrictEqual(['subscribe']);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.canvas)).toBe(true);
    expect(Object.isFrozen(api.stageView)).toBe(true);
  });

  it('gets the StageView snapshot, then the canvas section as main changes it', async () => {
    const { windows } = startMain();
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
      },
    });

    windows.update({ canvas: CANVAS });
    await settle();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0].view.canvas).toStrictEqual(CANVAS);
  });

  it('canvas.ready reaches main, which logs 畫布就緒 with the renderer and size', async () => {
    startMain();
    const api = await loadApi();

    const result = await api.canvas.ready({
      ok: true,
      renderer: 'webgl',
      width: 1512,
      height: 982,
    });

    expect(result).toStrictEqual({ ok: true, data: null });
    expect(lines(info)).toContain(
      '[windows] canvas ready (renderer webgl, 1512x982)',
    );
  });

  it('a failed canvas is logged as an error; the app goes on', async () => {
    startMain();
    const api = await loadApi();

    const result = await api.canvas.ready({
      ok: false,
      reason: 'Error: WebGL unsupported',
    });

    expect(result).toStrictEqual({ ok: true, data: null });
    expect(lines(error)).toContain(
      '[windows] canvas failed to initialise: Error: WebGL unsupported',
    );
  });

  it('canvas.ready answers invalid-input to a malformed report', async () => {
    startMain();
    const api = await loadApi();

    const result = await api.canvas.ready({
      ok: false,
      reason: 'x'.repeat(10_000),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
  });
});

describe('cross-window calls (B7)', () => {
  it('the overlay calling settings:patch is sender-rejected and nothing changes', async () => {
    const { settings: store } = startMain();

    const reply = await fake.ipcRenderer.invoke(settingsPatch.channel, {
      baseRev: 0,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: 5 }],
    });

    expect(reply).toStrictEqual({
      ok: false,
      error: { code: 'sender-rejected', message: 'sender is not allowed' },
    });
    expect(store.get()).toStrictEqual({ rev: 0, values: SETTINGS_DEFAULTS });
    expect(lines(warn)).toContain(
      '[ipc] settings:patch: sender rejected: renderer overlay may not use this channel',
    );
  });

  it('the panels calling canvas:ready is sender-rejected and nothing is logged as ready', async () => {
    startMain();
    fake.sender.mainFrame.url = 'app://panels/index.html';

    const reply = await fake.ipcRenderer.invoke(canvasReady.channel, {
      ok: true,
      renderer: 'webgl',
      width: 1,
      height: 1,
    });

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'sender-rejected' },
    });
    expect(lines(info).some((line) => line.includes('canvas ready'))).toBe(
      false,
    );
    expect(lines(warn)).toContain(
      '[ipc] canvas:ready: sender rejected: renderer panels may not use this channel',
    );
  });
});
