import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import type { BrowserWindowConstructorOptions } from 'electron';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { WindowsEnvironment } from '../../src/main/windows/environment';
import {
  createPanelWindows,
  panelUrl,
  panelWebPreferences,
  panelWindowOptions,
  PRELOAD_BUNDLES,
  type PanelWindowHandle,
} from '../../src/main/windows/panel-window';
import { OVERLAY_HOST, PANELS_HOST } from '../../src/main/windows/protocols';

vi.mock('electron', () => import('../helpers/fake-electron'));

const DEV_URL = 'http://localhost:5173';
const PACKAGED: WindowsEnvironment = {
  packaged: true,
  devServers: { panels: undefined, overlay: undefined },
};
const DEV: WindowsEnvironment = {
  packaged: false,
  devServers: {
    panels: { url: DEV_URL, origin: DEV_URL },
    overlay: { url: 'http://localhost:5174', origin: 'http://localhost:5174' },
  },
};
const PRELOAD = '/app/.vite/build/panels.cjs';

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A fake BrowserWindow that records what the panel does to it. */
class FakeWindow implements PanelWindowHandle {
  static created: FakeWindow[] = [];
  readonly calls: string[] = [];
  readonly loaded: string[] = [];
  readonly devTools: { mode: 'detach' }[] = [];
  url = '';
  destroyed = false;
  minimized = false;
  readonly windowListeners = new Map<string, (() => void)[]>();
  readonly contentsListeners = new Map<
    string,
    ((...args: never[]) => void)[]
  >();
  /** When set, loadURL rejects the way Electron does for an aborted load. */
  static rejectLoads = false;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    FakeWindow.created.push(this);
  }

  readonly webContents = {
    loadURL: (url: string) => {
      this.loaded.push(url);
      this.url = url;
      return FakeWindow.rejectLoads
        ? Promise.reject(new Error('ERR_ABORTED (-3) loading url'))
        : Promise.resolve();
    },
    getURL: () => this.url,
    openDevTools: (options: { mode: 'detach' }) => {
      this.devTools.push(options);
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      const list = this.contentsListeners.get(event) ?? [];
      list.push(listener);
      this.contentsListeners.set(event, list);
    },
  };

  once(event: string, listener: () => void) {
    this.addWindowListener(event, listener);
  }
  on(event: string, listener: () => void) {
    this.addWindowListener(event, listener);
  }
  private addWindowListener(event: string, listener: () => void) {
    const list = this.windowListeners.get(event) ?? [];
    list.push(listener);
    this.windowListeners.set(event, list);
  }
  emit(event: string) {
    for (const listener of this.windowListeners.get(event) ?? []) {
      listener();
    }
  }
  emitContents(event: string, ...args: unknown[]) {
    for (const listener of this.contentsListeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
    this.calls.push('restore');
  }
  show() {
    this.calls.push('show');
  }
  focus() {
    this.calls.push('focus');
  }
  destroy() {
    this.calls.push('destroy');
    this.destroyed = true;
    this.emit('closed');
  }
  /** What the user closing the window does. */
  close() {
    this.destroyed = true;
    this.emit('closed');
  }
}

function setup(env: WindowsEnvironment = PACKAGED) {
  FakeWindow.created = [];
  const dock = { panelOpened: vi.fn(), panelClosed: vi.fn() };
  const focusApp = vi.fn();
  const panels = createPanelWindows({
    createWindow: (options) => new FakeWindow(options),
    preload: PRELOAD,
    env,
    dock,
    focusApp,
  });
  const win = () => FakeWindow.created.at(-1) as FakeWindow;
  return { panels, dock, focusApp, win };
}

describe('panel window settings', () => {
  it('has the AD-24 webPreferences, spelled out', () => {
    expect(panelWebPreferences(PRELOAD)).toStrictEqual({
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
    });
  });

  it('is 960 x 680, centred, hidden until ready-to-show', () => {
    expect(panelWindowOptions(PRELOAD)).toStrictEqual({
      width: 960,
      height: 680,
      center: true,
      show: false,
      title: 'AI Watchdog Pet',
      webPreferences: panelWebPreferences(PRELOAD),
    });
  });
});

describe('panelUrl', () => {
  it.each([
    ['sessions', 'app://panels/index.html#/sessions'],
    ['packs', 'app://panels/index.html#/packs'],
    ['settings', 'app://panels/index.html#/settings'],
  ] as const)('packaged: %s -> %s', (page, url) => {
    expect(panelUrl(page, PACKAGED)).toBe(url);
  });

  it.each([
    ['sessions', `${DEV_URL}/#/sessions`],
    ['packs', `${DEV_URL}/#/packs`],
  ] as const)('dev: %s -> %s', (page, url) => {
    expect(panelUrl(page, DEV)).toBe(url);
  });

  it('never uses file://', () => {
    for (const env of [PACKAGED, DEV]) {
      expect(panelUrl('sessions', env)).not.toMatch(/^file:/);
    }
  });
});

describe('opening the panel', () => {
  it('creates one window on the page, tells the Dock, and logs it', () => {
    const { panels, dock, win } = setup();
    panels.open('packs');
    expect(FakeWindow.created).toHaveLength(1);
    expect(win().options).toStrictEqual(panelWindowOptions(PRELOAD));
    expect(win().loaded).toStrictEqual(['app://panels/index.html#/packs']);
    expect(dock.panelOpened).toHaveBeenCalledOnce();
    expect(panels.isOpen()).toBe(true);
    expect(lines(info)).toContain('[windows] panel opened on packs');
  });

  it('shows and focuses it on ready-to-show, making the app active', () => {
    const { panels, focusApp, win } = setup();
    panels.open('sessions');
    expect(win().calls).toStrictEqual([]);
    win().emit('ready-to-show');
    expect(win().calls).toStrictEqual(['show', 'focus']);
    expect(focusApp).toHaveBeenCalledOnce();
  });

  it('opens DevTools detached in dev only', () => {
    const dev = setup(DEV);
    dev.panels.open('sessions');
    expect(dev.win().devTools).toStrictEqual([{ mode: 'detach' }]);
    expect(dev.win().loaded).toStrictEqual([`${DEV_URL}/#/sessions`]);

    const packaged = setup(PACKAGED);
    packaged.panels.open('sessions');
    expect(packaged.win().devTools).toStrictEqual([]);
  });

  it('switches the open panel to another page and brings it to the front', () => {
    const { panels, dock, win } = setup();
    panels.open('sessions');
    const first = win();
    first.minimized = true;
    panels.open('settings');
    expect(FakeWindow.created).toHaveLength(1);
    expect(first.loaded).toStrictEqual([
      'app://panels/index.html#/sessions',
      'app://panels/index.html#/settings',
    ]);
    expect(first.calls).toStrictEqual(['restore', 'show', 'focus']);
    expect(dock.panelOpened).toHaveBeenCalledOnce();
    expect(lines(info)).toContain('[windows] panel switched to settings');
  });

  it('only brings it to the front when it already shows the page', () => {
    const { panels, win } = setup();
    panels.open('packs');
    panels.open('packs');
    expect(win().loaded).toHaveLength(1);
    expect(win().calls).toStrictEqual(['show', 'focus']);
  });

  it('swallows a rejected load (did-fail-load reports it)', async () => {
    const { panels, win } = setup();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    FakeWindow.rejectLoads = true;
    try {
      panels.open('packs');
      panels.open('settings');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      FakeWindow.rejectLoads = false;
      process.off('unhandledRejection', unhandled);
    }
    expect(win().loaded).toHaveLength(2);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('closing the panel', () => {
  it('tells the Dock, logs it, and lets the menu open a new one', () => {
    const { panels, dock, win } = setup();
    panels.open('sessions');
    const first = win();
    first.close();
    expect(dock.panelClosed).toHaveBeenCalledOnce();
    expect(panels.isOpen()).toBe(false);
    expect(lines(info)).toContain('[windows] panel closed');

    panels.open('packs');
    expect(FakeWindow.created).toHaveLength(2);
    expect(win()).not.toBe(first);
    expect(dock.panelOpened).toHaveBeenCalledTimes(2);
  });

  it('treats a destroyed window as closed', () => {
    const { panels, win } = setup();
    panels.open('sessions');
    win().destroyed = true;
    expect(panels.isOpen()).toBe(false);
    panels.open('sessions');
    expect(FakeWindow.created).toHaveLength(2);
  });
});

describe('panel errors', () => {
  it('closes the panel when the page fails to load, and logs why', () => {
    const { panels, dock, win } = setup();
    panels.open('sessions');
    win().emitContents(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app://panels/index.html',
      true,
    );
    expect(win().calls).toContain('destroy');
    expect(dock.panelClosed).toHaveBeenCalledOnce();
    expect(panels.isOpen()).toBe(false);
    expect(lines(error)).toStrictEqual([
      '[windows] panel closed after an error: load failed (-6 ERR_FILE_NOT_FOUND)',
    ]);
  });

  it('ignores an aborted load and a failed subframe', () => {
    const { panels, win } = setup();
    panels.open('sessions');
    win().emitContents('did-fail-load', {}, -3, 'ERR_ABORTED', 'x', true);
    win().emitContents('did-fail-load', {}, -6, 'ERR_FILE', 'x', false);
    expect(win().calls).not.toContain('destroy');
    expect(panels.isOpen()).toBe(true);
  });

  it('closes the panel when its renderer goes away, and logs why', () => {
    const { panels, dock, win } = setup();
    panels.open('sessions');
    win().emitContents(
      'render-process-gone',
      {},
      {
        reason: 'crashed',
        exitCode: 11,
      },
    );
    expect(win().calls).toContain('destroy');
    expect(dock.panelClosed).toHaveBeenCalledOnce();
    expect(lines(error)).toStrictEqual([
      '[windows] panel closed after an error: renderer gone (crashed, exit code 11)',
    ]);

    panels.open('sessions');
    expect(FakeWindow.created).toHaveLength(2);
  });
});

describe('preload bundle names and forge.config.mts', () => {
  interface ForgeEntry {
    entry?: string;
    target?: string;
    name?: string;
  }

  interface VitePluginLike {
    readonly name: string;
    readonly config: {
      readonly build: readonly ForgeEntry[];
      readonly renderer: readonly ForgeEntry[];
    };
  }

  let config: ForgeConfig;
  let vite: VitePluginLike['config'];

  // forge.config.mts itself, and its Vite plugin's entries, loaded once: the
  // first import pulls in Forge's makers and plugins and can be slow.
  beforeAll(async () => {
    // A URL keeps tsc from resolving the .mts path (no
    // allowImportingTsExtensions); Vitest imports it as usual.
    const configUrl = new URL('../../forge.config.mts', import.meta.url).href;
    config = (
      (await import(/* @vite-ignore */ configUrl)) as { default: ForgeConfig }
    ).default;
    const plugin = (config.plugins ?? []).find(
      (p) => typeof p === 'object' && 'name' in p && p.name === 'vite',
    ) as VitePluginLike | undefined;
    if (plugin === undefined) {
      throw new Error('forge.config.mts has no Vite plugin');
    }
    vite = plugin.config;
  }, 30_000);

  it('names every preload entry, and only those, as <entry>.cjs', () => {
    const fromForge = vite.build
      .filter((entry) => entry.target === 'preload')
      .map((entry) => `${path.parse(entry.entry ?? '').name}.cjs`)
      .sort();
    expect(Object.values(PRELOAD_BUNDLES).sort()).toStrictEqual(fromForge);
    expect(PRELOAD_BUNDLES.panels).toBe('panels.cjs');
  });

  it('builds the panels and overlay renderers under the names app:// serves', () => {
    expect(vite.renderer.map((entry) => entry.name)).toStrictEqual([
      PANELS_HOST,
      OVERLAY_HOST,
    ]);
    expect(vite.renderer.map((entry) => entry.name)).toStrictEqual([
      'panels',
      'overlay',
    ]);
  });

  it('builds the overlay from src/overlay into .vite/renderer/overlay, without the React plugin', async () => {
    const overlay = vite.renderer.find((entry) => entry.name === 'overlay') as
      | { config?: string }
      | undefined;
    expect(overlay?.config).toBe('vite.overlay.config.mts');

    const configUrl = new URL('../../vite.overlay.config.mts', import.meta.url)
      .href;
    const factory = (
      (await import(/* @vite-ignore */ configUrl)) as {
        default: (env: unknown) => {
          root?: string;
          plugins?: unknown[];
          build?: { outDir?: string };
        };
      }
    ).default;
    const root = path.join(path.sep, 'repo');
    const built = factory({
      root,
      forgeConfigSelf: { name: 'overlay' },
      command: 'build',
      mode: 'production',
    });
    expect(built.root).toBe(path.join(root, 'src/overlay'));
    expect(built.build?.outDir).toBe(
      path.join(root, '.vite/renderer', 'overlay'),
    );
    expect(built.plugins ?? []).toStrictEqual([]);
    // Not the panels' default node_modules/.vite: two dev servers sharing it
    // replace each other's prebundled deps.
    expect((built as { cacheDir?: string }).cacheDir).toBe(
      path.join(root, 'node_modules/.vite-overlay'),
    );
  });

  it('marks the macOS app as a menu bar app (LSUIElement)', () => {
    expect(config.packagerConfig?.extendInfo).toStrictEqual({
      LSUIElement: true,
    });
  });
});
