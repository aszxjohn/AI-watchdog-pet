/**
 * src/main/main.ts wiring, with electron and every module main.ts calls
 * replaced by recorders: what runs, in which order, for a Squirrel event, a
 * second instance and the primary instance. Each module's own behaviour is
 * tested in its own file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const state = vi.hoisted(() => {
  const s = {
    squirrel: false,
    lock: true,
    preloadExists: true,
    order: [] as string[],
    logs: [] as string[],
    listeners: new Map<string, Listener[]>(),
    resolveReady: () => {},
    ready: Promise.resolve(),
    trayActions: undefined as
      | { openPage(page: string): void; quit(): void }
      | undefined,
    /** What main.ts passed to createPanelWindows. */
    panelOptions: undefined as { focusApp?: () => void } | undefined,
    reset() {
      s.squirrel = false;
      s.lock = true;
      s.preloadExists = true;
      s.order = [];
      s.logs = [];
      s.listeners = new Map();
      s.trayActions = undefined;
      s.panelOptions = undefined;
      s.ready = new Promise<void>((resolve) => {
        s.resolveReady = resolve;
      });
    },
  };
  return s;
});

const record = (name: string) => () => {
  state.order.push(name);
};

vi.mock('electron-squirrel-startup', () => ({
  get default() {
    return state.squirrel;
  },
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    dock: { show: async () => {}, hide: () => {} },
    requestSingleInstanceLock: () => {
      state.order.push('requestSingleInstanceLock');
      return state.lock;
    },
    quit: () => {
      state.order.push('app.quit');
    },
    exit: (code: number) => {
      state.order.push(`app.exit ${code}`);
    },
    focus: (options: unknown) => {
      state.order.push(`app.focus ${JSON.stringify(options)}`);
    },
    getPath: (name: string) => `/fake/${name}`,
    getVersion: () => '1.0.0',
    on: (event: string, listener: Listener) => {
      const list = state.listeners.get(event) ?? [];
      list.push(listener);
      state.listeners.set(event, list);
    },
    whenReady: () => state.ready,
  },
  BrowserWindow: class {
    constructor() {
      state.order.push('new BrowserWindow');
    }
  },
  dialog: {
    showErrorBox: (title: string) => {
      state.order.push(`dialog.showErrorBox ${title}`);
    },
  },
  Menu: {
    setApplicationMenu: (menu: unknown) => {
      state.order.push(`Menu.setApplicationMenu ${JSON.stringify(menu)}`);
    },
  },
  session: { defaultSession: { fake: 'session' } },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = () => state.preloadExists;
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock('../../src/main/log/run-log', () => ({
  initRunLog: (dir: string) => {
    state.order.push(`initRunLog ${dir.replaceAll('\\', '/')}`);
  },
  logEvent: (category: string, message: string) => {
    state.logs.push(`${category}: ${message}`);
  },
  errorCode: () => 'Error',
}));

vi.mock('../../src/main/settings/store', () => ({
  loadSettings: () => {
    state.order.push('loadSettings');
    return { fake: 'settings' };
  },
  flushSettingsOnQuit: record('flushSettingsOnQuit'),
}));

vi.mock('../../src/main/settings/ipc', () => ({
  registerSettingsHandlers: record('registerSettingsHandlers'),
}));

vi.mock('../../src/main/stage-view/stage-view', () => ({
  createStageView: () => {
    state.order.push('createStageView');
    return { fake: 'stage-view' };
  },
  registerStageViewHandlers: record('registerStageViewHandlers'),
}));

vi.mock('../../src/main/ipc/register', () => ({
  registerIpcHandler: (contract: { channel: string }) => {
    state.order.push(`registerIpcHandler ${contract.channel}`);
  },
}));

vi.mock('../../src/main/windows/protocols', () => ({
  registerSchemes: record('registerSchemes'),
  handleAppProtocol: record('handleAppProtocol'),
}));

vi.mock('../../src/main/windows/environment', () => ({
  currentEnvironment: () => ({
    packaged: false,
    devServerUrl: undefined,
    devServerOrigin: undefined,
  }),
}));

vi.mock('../../src/main/windows/security', () => ({
  installWebContentsGuards: record('installWebContentsGuards'),
  installSessionGuards: (session: unknown) => {
    state.order.push(`installSessionGuards ${JSON.stringify(session)}`);
  },
}));

vi.mock('../../src/main/windows/dock', () => ({
  createDockController: () => {
    state.order.push('createDockController');
    return { hideAtStartup: record('dock.hideAtStartup') };
  },
}));

vi.mock('../../src/main/windows/panel-window', () => ({
  PRELOAD_BUNDLES: { panels: 'panels.cjs', overlay: 'overlay.cjs' },
  createPanelWindows: (options: { preload: string; focusApp?: () => void }) => {
    state.panelOptions = options;
    state.order.push(
      `createPanelWindows ${options.preload.split(/[\\/]/).at(-1)}`,
    );
    return {
      open: (page: string) => {
        state.order.push(`panels.open ${page}`);
      },
      isOpen: () => false,
    };
  },
}));

vi.mock('../../src/main/windows/menu', () => ({
  buildApplicationMenu: (platform: string) => {
    state.order.push(`buildApplicationMenu ${platform}`);
    return { fake: `menu ${platform}` };
  },
}));

vi.mock('../../src/main/windows/tray', () => ({
  createTray: (
    platform: string,
    actions: { openPage(page: string): void; quit(): void },
  ) => {
    state.order.push(`createTray ${platform}`);
    state.trayActions = actions;
  },
}));

/** Imports a fresh copy of main.ts, which runs its startup. */
async function startMain(): Promise<void> {
  vi.resetModules();
  await import('../../src/main/main');
}

async function becomeReady(): Promise<void> {
  state.resolveReady();
  await state.ready;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function emit(event: string, ...args: unknown[]): void {
  for (const listener of state.listeners.get(event) ?? []) {
    listener(...args);
  }
}

let info: ReturnType<typeof vi.spyOn>;
const realPlatform = process.platform;

/** Makes `process.platform` read `platform` until the test ends. */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  state.reset();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('a process that must not start', () => {
  it('quits on a Squirrel event without initialising anything or taking the lock', async () => {
    state.squirrel = true;
    await startMain();
    await becomeReady();
    expect(state.order).toStrictEqual(['app.quit']);
    expect(state.logs).toStrictEqual([]);
    expect(state.listeners.size).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  it('quits as a second instance without initialising anything', async () => {
    state.lock = false;
    await startMain();
    await becomeReady();
    expect(state.order).toStrictEqual([
      'requestSingleInstanceLock',
      'app.quit',
    ]);
    expect(state.logs).toStrictEqual([]);
    expect(state.listeners.size).toBe(0);
  });

  it('says on the console, not in the run log, that another instance holds the lock', async () => {
    state.lock = false;
    await startMain();
    expect(info.mock.calls).toStrictEqual([
      [
        '[app] another instance holds the single-instance lock (it opens its main panel); exiting',
      ],
    ]);
    expect(state.order.some((entry) => entry.startsWith('initRunLog'))).toBe(
      false,
    );
  });
});

describe('the primary instance', () => {
  it('registers the schemes first, then runs the Story 1.4 wiring and the window guards', async () => {
    await startMain();
    expect(state.order).toStrictEqual([
      'requestSingleInstanceLock',
      'registerSchemes',
      'initRunLog /fake/userData/logs',
      'loadSettings',
      'createStageView',
      'registerIpcHandler app:get-version',
      'registerSettingsHandlers',
      'registerStageViewHandlers',
      'flushSettingsOnQuit',
      'installWebContentsGuards',
      'createDockController',
      'createPanelWindows panels.cjs',
    ]);
    expect(state.logs[0]).toMatch(/^app: start version=1\.0\.0 /);
  });

  it('once ready: session guards, application menu, app:// handler, Dock hidden, tray; no window', async () => {
    await startMain();
    state.order = [];
    await becomeReady();
    expect(state.order).toStrictEqual([
      'installSessionGuards {"fake":"session"}',
      `buildApplicationMenu ${process.platform}`,
      `Menu.setApplicationMenu {"fake":"menu ${process.platform}"}`,
      'handleAppProtocol',
      'dock.hideAtStartup',
      `createTray ${process.platform}`,
    ]);
    expect(state.order.join('\n')).not.toMatch(/BrowserWindow|panels\.open/);
  });

  it('keeps running when every window is closed', async () => {
    await startMain();
    await becomeReady();
    expect(state.listeners.get('window-all-closed')).toHaveLength(1);
    state.order = [];
    emit('window-all-closed');
    expect(state.order).toStrictEqual([]);
  });

  it('opens the main panel when launched again, and logs it', async () => {
    await startMain();
    await becomeReady();
    state.order = [];
    emit('second-instance', {}, ['electron', '.'], '/repo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.order).toStrictEqual(['panels.open sessions']);
    expect(state.logs).toContain(
      'windows: second instance launched: opening the main panel',
    );
  });

  it('waits for ready before opening a panel for an early second launch', async () => {
    await startMain();
    emit('second-instance', {}, [], '/repo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.order).not.toContain('panels.open sessions');
    await becomeReady();
    expect(state.order.at(-1)).toBe('panels.open sessions');
  });

  it('macOS activate (relaunch from Finder or Spotlight) opens the main panel, open or not', async () => {
    await startMain();
    await becomeReady();
    for (const hasVisibleWindows of [false, true]) {
      state.order = [];
      emit('activate', {}, hasVisibleWindows);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.order).toStrictEqual(['panels.open sessions']);
    }
    expect(state.logs).toContain(
      'windows: app activated: opening the main panel',
    );
  });

  it('macOS: the panel makes the app active with app.focus({ steal: true })', async () => {
    setPlatform('darwin');
    await startMain();
    expect(state.panelOptions?.focusApp).toBeTypeOf('function');
    state.order = [];
    state.panelOptions?.focusApp?.();
    expect(state.order).toStrictEqual(['app.focus {"steal":true}']);
  });

  it.each([['win32'], ['linux']] as const)(
    '%s: the panel gets no focusApp',
    async (platform) => {
      setPlatform(platform);
      await startMain();
      expect(state.panelOptions).toBeDefined();
      expect(state.panelOptions?.focusApp).toBeUndefined();
    },
  );

  it('wires the tray menu to the panel and to quit', async () => {
    await startMain();
    await becomeReady();
    state.order = [];
    state.trayActions?.openPage('packs');
    state.trayActions?.quit();
    expect(state.order).toStrictEqual(['panels.open packs', 'app.quit']);
  });

  it('logs the quit on will-quit, after the settings flush was registered', async () => {
    await startMain();
    const willQuit = state.listeners.get('will-quit') ?? [];
    expect(willQuit).toHaveLength(1);
    willQuit[0]?.();
    expect(state.logs.at(-1)).toBe('app: quit');
  });

  it('shows why and exits when the panels preload bundle is missing', async () => {
    state.preloadExists = false;
    await startMain();
    expect(state.order).toContain(
      'dialog.showErrorBox AI Watchdog Pet 無法啟動',
    );
    expect(state.order).toContain('app.exit 1');
    expect(state.logs.some((line) => line.includes('panels.cjs'))).toBe(true);
  });
});
