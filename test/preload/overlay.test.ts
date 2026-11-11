import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDetection } from '../../src/main/detection/detection';
import { registerSettingsHandlers } from '../../src/main/settings/ipc';
import {
  loadSettings,
  type SettingsStore,
} from '../../src/main/settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from '../../src/main/stage-view/stage-view';
import {
  registerCanvasContextMenuHandler,
  registerCanvasHoverHandler,
  registerCanvasReadyHandler,
} from '../../src/main/windows/canvas-window';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import type { SessionKey } from '../../src/shared/detection-events';
import {
  canvasContextMenu,
  canvasReady,
  canvasSetHover,
  settingsPatch,
  type CanvasHover,
} from '../../src/shared/ipc';
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
  const detection = createDetection({ settings });
  registerStageViewHandlers(createStageView({ settings, windows, detection }));
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
    expect(Object.keys(api.canvas)).toStrictEqual([
      'ready',
      'setHover',
      'contextMenu',
    ]);
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
        sessions: [],
        adapters: [],
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

describe('canvas hover and right-click', () => {
  /** The canvas handlers, on a canvas whose window is the fake sender's. */
  function startCanvas() {
    const hovers: [number, CanvasHover][] = [];
    const menus: SessionKey[] = [];
    const win = { id: 'canvas-window' };
    registerCanvasHoverHandler({
      setHover: (webContentsId, hover) => {
        hovers.push([webContentsId, hover]);
      },
    });
    registerCanvasContextMenuHandler(
      {
        windowOf: (webContentsId) =>
          webContentsId === fake.sender.id ? win : undefined,
      },
      (sessionKey) => {
        menus.push(sessionKey);
      },
    );
    return { hovers, menus };
  }

  it('canvas.setHover reaches main with the sending page and the request', async () => {
    const { hovers } = startCanvas();
    const api = await loadApi();

    const result = await api.canvas.setHover({ seq: 1, over: true });

    expect(result).toStrictEqual({ ok: true, data: null });
    expect(hovers).toStrictEqual([[fake.sender.id, { seq: 1, over: true }]]);
  });

  it('canvas.setHover answers invalid-input to a bad request; main hears nothing', async () => {
    const { hovers } = startCanvas();
    const api = await loadApi();

    const result = await api.canvas.setHover({ seq: 0, over: true });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(hovers).toStrictEqual([]);
  });

  it('canvas.contextMenu sends { sessionKey } and reaches main', async () => {
    const { menus } = startCanvas();
    const api = await loadApi();

    const result = await api.canvas.contextMenu('demo:1');

    expect(result).toStrictEqual({ ok: true, data: null });
    expect(menus).toStrictEqual(['demo:1']);
  });

  it('the panels calling canvas:set-hover or canvas:context-menu are sender-rejected', async () => {
    const { hovers, menus } = startCanvas();
    fake.sender.mainFrame.url = 'app://panels/index.html';

    for (const [channel, request] of [
      [canvasSetHover.channel, { seq: 1, over: true }],
      [canvasContextMenu.channel, { sessionKey: 'demo:1' }],
    ] as const) {
      expect(await fake.ipcRenderer.invoke(channel, request)).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
    }
    expect(hovers).toStrictEqual([]);
    expect(menus).toStrictEqual([]);
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
