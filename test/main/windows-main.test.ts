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
    /** The run log lines logged at error level. */
    errors: [] as string[],
    /** Settings writes and run log lines, in the order they happened. */
    events: [] as string[],
    /** Recorded calls (as in `order`) that throw an error with code EFAKE. */
    failing: new Set<string>(),
    /** What the panel mock's isOpen() answers. */
    panelOpen: false,
    listeners: new Map<string, Listener[]>(),
    resolveReady: () => {},
    ready: Promise.resolve(),
    trayActions: undefined as
      | {
          openPage(page: string): void;
          setDemo(state: string | null): void;
          quit(): void;
        }
      | undefined,
    /** What main.ts passed to buildApplicationMenu. */
    menuActions: undefined as { closePanel(): void } | undefined,
    /** What main.ts passed to createPanelWindows. */
    panelOptions: undefined as { focusApp?: () => void } | undefined,
    /** What main.ts passed to watchDisplays and watchPower. */
    displaysOptions: undefined as Record<string, unknown> | undefined,
    powerArgs: undefined as unknown[] | undefined,
    /** What main.ts passed to watchSleep. */
    sleepArgs: undefined as unknown[] | undefined,
    /** What main.ts passed to registerCanvasHoverHandler. */
    hoverCanvas: undefined as unknown,
    /** The right-click callback main.ts passed to registerCanvasContextMenuHandler. */
    openMenu: undefined as
      | ((sessionKey: string, win: unknown) => void)
      | undefined,
    /** What the right-click callback passed to openCanvasMenu. */
    menuArgs: undefined as
      | [
          string,
          unknown,
          {
            sessionKey: string;
            state(): string | null;
            setDemo(state: string | null): void;
          },
        ]
      | undefined,
    /** The listener main.ts passed to watchDemoState. */
    demoListener: undefined as ((state: string | null) => void) | undefined,
    reset() {
      s.squirrel = false;
      s.lock = true;
      s.preloadExists = true;
      s.order = [];
      s.logs = [];
      s.errors = [];
      s.events = [];
      s.failing = new Set();
      s.panelOpen = false;
      s.listeners = new Map();
      s.trayActions = undefined;
      s.menuActions = undefined;
      s.panelOptions = undefined;
      s.displaysOptions = undefined;
      s.powerArgs = undefined;
      s.sleepArgs = undefined;
      s.hoverCanvas = undefined;
      s.openMenu = undefined;
      s.menuArgs = undefined;
      s.demoListener = undefined;
      s.ready = new Promise<void>((resolve) => {
        s.resolveReady = resolve;
      });
    },
    /** Throws, like a failing Electron call, when `name` is in `failing`. */
    maybeFail(name: string) {
      if (s.failing.has(name)) {
        throw Object.assign(new Error(`${name} failed`), { code: 'EFAKE' });
      }
    },
  };
  return s;
});

const record = (name: string) => () => {
  state.order.push(name);
  state.maybeFail(name);
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
      state.maybeFail('dialog.showErrorBox');
    },
  },
  Menu: {
    setApplicationMenu: (menu: unknown) => {
      state.order.push(`Menu.setApplicationMenu ${JSON.stringify(menu)}`);
    },
  },
  session: { defaultSession: { fake: 'session' } },
  screen: { fake: 'screen' },
  powerMonitor: { fake: 'powerMonitor' },
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
  logEvent: (category: string, message: string, level = 'info') => {
    state.logs.push(`${category}: ${message}`);
    state.events.push(`log ${category}: ${message}`);
    if (level === 'error') {
      state.errors.push(`${category}: ${message}`);
    }
  },
  errorCode: (error: unknown) => (error as { code?: string }).code ?? 'Error',
}));

vi.mock('../../src/main/settings/store', () => ({
  loadSettings: () => {
    state.order.push('loadSettings');
    return { fake: 'settings' };
  },
  // Like the real one: a will-quit listener that writes pending settings.
  flushSettingsOnQuit: (app: {
    on(event: string, listener: Listener): void;
  }) => {
    state.order.push('flushSettingsOnQuit');
    app.on('will-quit', () => {
      state.events.push('settings flushed');
    });
  },
}));

vi.mock('../../src/main/settings/ipc', () => ({
  registerSettingsHandlers: record('registerSettingsHandlers'),
}));

vi.mock('../../src/main/stage-view/stage-view', () => ({
  createStageView: (sources: Record<string, unknown>) => {
    state.order.push(
      `createStageView ${Object.entries(sources)
        .map(([name, source]) => `${name}=${JSON.stringify(source)}`)
        .join(' ')}`,
    );
    return { fake: 'stage-view' };
  },
  registerStageViewHandlers: record('registerStageViewHandlers'),
}));

vi.mock('../../src/main/ipc/register', () => ({
  registerIpcHandler: (contract: { channel: string }, renderers: string[]) => {
    state.order.push(
      `registerIpcHandler ${contract.channel} ${JSON.stringify(renderers)}`,
    );
  },
}));

vi.mock('../../src/main/windows/stage-sources', () => ({
  createWindowsStageSource: () => {
    state.order.push('createWindowsStageSource');
    return { fake: 'windows-source' };
  },
  watchDisplays: (options: Record<string, unknown>) => {
    state.displaysOptions = options;
    state.order.push('watchDisplays');
    state.maybeFail('watchDisplays');
  },
}));

vi.mock('../../src/main/detection/adapters/claude-code/claude-code', () => ({
  createClaudeCodeAdapter: (options: { root: string }) => {
    // The real home folder's projects folder; only its tail is checked.
    const tail = options.root.split(/[\\/]/).slice(-2).join('/');
    state.order.push(`createClaudeCodeAdapter root=~/${tail}`);
    return { fake: 'claude-code-adapter' };
  },
}));

vi.mock('../../src/main/detection/detection', () => ({
  createDetection: (options: { settings: unknown; adapters?: unknown }) => {
    state.order.push(
      `createDetection settings=${JSON.stringify(options.settings)} adapters=${JSON.stringify(options.adapters)}`,
    );
    return {
      fake: 'detection',
      get: () => ({ sessions: ['fake sessions'], adapters: [] }),
      setDemo: (demoState: string | null) => {
        state.order.push(`detection.setDemo ${String(demoState)}`);
      },
      stop: record('detection.stop'),
    };
  },
  demoStateOf: (sessions: unknown) => {
    state.order.push(`demoStateOf ${JSON.stringify(sessions)}`);
    return 'error';
  },
  watchDemoState: (
    detection: { fake: string },
    listener: (demoState: string | null) => void,
  ) => {
    state.order.push(`watchDemoState ${detection.fake}`);
    state.demoListener = listener;
    state.maybeFail('watchDemoState');
  },
  watchSleep: (...args: unknown[]) => {
    state.sleepArgs = args;
    state.order.push('watchSleep');
    state.maybeFail('watchSleep');
  },
}));

vi.mock('../../src/main/windows/power', () => ({
  watchPower: (...args: unknown[]) => {
    state.powerArgs = args;
    state.order.push('watchPower');
    state.maybeFail('watchPower');
  },
}));

vi.mock('../../src/main/windows/canvas-window', () => ({
  registerCanvasReadyHandler: record('registerCanvasReadyHandler'),
  registerCanvasHoverHandler: (canvas: { fake: string }) => {
    state.order.push(`registerCanvasHoverHandler ${canvas.fake}`);
    state.hoverCanvas = canvas;
  },
  registerCanvasContextMenuHandler: (
    canvas: { fake: string },
    open: (sessionKey: string, win: unknown) => void,
  ) => {
    state.order.push(`registerCanvasContextMenuHandler ${canvas.fake}`);
    state.openMenu = open;
  },
  createCanvasWindows: (options: { preload: string; platform: string }) => {
    state.order.push(
      `createCanvasWindows ${options.preload.split(/[\\/]/).at(-1)} ${options.platform}`,
    );
    return {
      fake: 'canvas',
      stop: record('canvas.stop'),
    };
  },
}));

vi.mock('../../src/main/windows/protocols', () => ({
  registerSchemes: record('registerSchemes'),
  handleAppProtocol: record('handleAppProtocol'),
}));

vi.mock('../../src/main/windows/environment', () => ({
  currentEnvironment: () => ({
    packaged: false,
    devServers: { panels: undefined, overlay: undefined },
  }),
}));

vi.mock('../../src/main/windows/security', () => ({
  installWebContentsGuards: record('installWebContentsGuards'),
  installSessionGuards: (session: unknown) => {
    state.order.push(`installSessionGuards ${JSON.stringify(session)}`);
    state.maybeFail('installSessionGuards');
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
      openOrFocus: (page: string) => {
        state.order.push(`panels.openOrFocus ${page}`);
        state.maybeFail('panels.openOrFocus');
      },
      close: record('panels.close'),
      isOpen: () => state.panelOpen,
    };
  },
}));

vi.mock('../../src/main/windows/menu', () => ({
  buildApplicationMenu: (platform: string, actions: { closePanel(): void }) => {
    state.order.push(`buildApplicationMenu ${platform}`);
    state.menuActions = actions;
    state.maybeFail('buildApplicationMenu');
    return { fake: `menu ${platform}` };
  },
  openCanvasMenu: (
    sessionKey: string,
    win: unknown,
    demo: NonNullable<typeof state.menuArgs>[2],
  ) => {
    state.order.push(`openCanvasMenu ${sessionKey} ${JSON.stringify(win)}`);
    state.menuArgs = [sessionKey, win, demo];
    return true;
  },
}));

vi.mock('../../src/main/windows/tray', () => ({
  createTray: (
    platform: string,
    actions: {
      openPage(page: string): void;
      setDemo(state: string | null): void;
      quit(): void;
    },
  ) => {
    state.order.push(`createTray ${platform}`);
    state.trayActions = actions;
    state.maybeFail('createTray');
  },
  showTrayDemoState: (demoState: string | null) => {
    state.order.push(`showTrayDemoState ${String(demoState)}`);
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

/** What runs once ready, in order, when nothing fails. */
function readySteps(): string[] {
  return [
    'installSessionGuards {"fake":"session"}',
    `buildApplicationMenu ${process.platform}`,
    `Menu.setApplicationMenu {"fake":"menu ${process.platform}"}`,
    'handleAppProtocol',
    'dock.hideAtStartup',
    `createTray ${process.platform}`,
    'watchDemoState detection',
    'watchDisplays',
    'watchPower',
    'watchSleep',
  ];
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
        '[app] another instance holds the single-instance lock (it brings up its panel); exiting',
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
      'createWindowsStageSource',
      'createClaudeCodeAdapter root=~/.claude/projects',
      'createDetection settings={"fake":"settings"} adapters=[{"fake":"claude-code-adapter"}]',
      'createStageView settings={"fake":"settings"} windows={"fake":"windows-source"} detection={"fake":"detection"}',
      'registerIpcHandler app:get-version ["panels"]',
      'registerSettingsHandlers',
      'registerStageViewHandlers',
      'registerCanvasReadyHandler',
      'flushSettingsOnQuit',
      'installWebContentsGuards',
      'createDockController',
      'createPanelWindows panels.cjs',
      `createCanvasWindows overlay.cjs ${process.platform}`,
      'registerCanvasHoverHandler canvas',
      'registerCanvasContextMenuHandler canvas',
    ]);
    expect(state.logs[0]).toMatch(/^app: start version=1\.0\.0 /);
  });

  it('once ready: session guards, application menu, app:// handler, Dock hidden, tray, then the canvas and the power and sleep watch; no panel', async () => {
    await startMain();
    state.order = [];
    await becomeReady();
    expect(state.order).toStrictEqual(readySteps());
    expect(state.order.join('\n')).not.toMatch(/BrowserWindow|panels\.open/);
    expect(state.errors).toStrictEqual([]);
  });

  it.each([
    ['menu', 'buildApplicationMenu'],
    ['app-protocol', 'handleAppProtocol'],
    ['dock', 'dock.hideAtStartup'],
    ['tray', 'createTray'],
    ['canvas', 'watchDisplays'],
    ['power', 'watchPower'],
    ['sleep', 'watchSleep'],
  ])(
    'once ready, a failing startup step (%s) is logged with its errorCode and the other steps still run, the tray included',
    async (step, call) => {
      state.failing.add(call);
      await startMain();
      state.order = [];
      await becomeReady();
      expect(state.errors).toStrictEqual([
        `app: startup step ${step} failed: EFAKE`,
      ]);
      expect(state.order).toStrictEqual(
        readySteps().filter(
          (entry) =>
            // A menu that cannot be built is not set, and a tray that
            // cannot be created has no check mark to follow detection.
            (step !== 'menu' || !entry.startsWith('Menu.')) &&
            (step !== 'tray' || !entry.startsWith('watchDemoState')),
        ),
      );
      expect(state.order).toContain(`createTray ${process.platform}`);
    },
  );

  it('once ready, failing session guards are logged and shown, and the app exits: no menu, tray or canvas', async () => {
    state.failing.add('installSessionGuards');
    await startMain();
    state.order = [];
    await becomeReady();
    expect(state.order).toStrictEqual([
      'installSessionGuards {"fake":"session"}',
      'dialog.showErrorBox AI Watchdog Pet 無法啟動',
      'app.exit 1',
    ]);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]).toMatch(
      /^app: startup step session-guards failed: EFAKE\./,
    );
  });

  it('once ready, a throw outside any step is logged with its errorCode, with no unhandled rejection', async () => {
    // The session guards fail, and so does the error box that reports it.
    state.failing.add('installSessionGuards');
    state.failing.add('dialog.showErrorBox');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await startMain();
      await becomeReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(state.errors.at(-1)).toBe('app: startup failed: EFAKE');
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('lays the canvas out from the screen and the settings, into the windows source', async () => {
    await startMain();
    await becomeReady();
    expect(state.displaysOptions).toStrictEqual({
      screen: { fake: 'screen' },
      settings: { fake: 'settings' },
      source: { fake: 'windows-source' },
      canvas: expect.objectContaining({ fake: 'canvas' }),
    });
    expect(state.powerArgs).toStrictEqual([
      { fake: 'powerMonitor' },
      { fake: 'windows-source' },
    ]);
    expect(state.sleepArgs).toStrictEqual([
      { fake: 'powerMonitor' },
      expect.objectContaining({ fake: 'detection' }),
    ]);
  });

  it('stops rebuilding the canvas, and stops detection, once the app is quitting', async () => {
    await startMain();
    const beforeQuit = state.listeners.get('before-quit') ?? [];
    expect(beforeQuit).toHaveLength(2);
    state.order = [];
    emit('before-quit');
    expect(state.order).toStrictEqual(['canvas.stop', 'detection.stop']);
  });

  it('stops detection on quit even when canvas.stop throws', async () => {
    state.failing.add('canvas.stop');
    await startMain();
    state.order = [];
    for (const listener of state.listeners.get('before-quit') ?? []) {
      try {
        listener();
      } catch {
        // Electron logs a throwing listener and calls the next one.
      }
    }
    expect(state.order).toStrictEqual(['canvas.stop', 'detection.stop']);
  });

  it('keeps running when every window is closed', async () => {
    await startMain();
    await becomeReady();
    expect(state.listeners.get('window-all-closed')).toHaveLength(1);
    state.order = [];
    emit('window-all-closed');
    expect(state.order).toStrictEqual([]);
  });

  describe.each([
    [
      'second-instance',
      'second instance launched',
      [{}, ['electron', '.'], '/repo'],
    ],
    ['activate', 'app activated', [{}, true]],
  ] as const)(
    '%s (a second launch; macOS: relaunch or Dock click)',
    (event, what, args) => {
      async function trigger(): Promise<void> {
        emit(event, ...args);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      it('opens the main panel when none is open, and logs it', async () => {
        await startMain();
        await becomeReady();
        state.order = [];
        state.panelOpen = false;
        await trigger();
        expect(state.order).toStrictEqual(['panels.openOrFocus sessions']);
        expect(state.logs).toContain(
          `windows: ${what}: opening the main panel`,
        );
        expect(state.errors).toStrictEqual([]);
      });

      it('only brings an open panel to the front, on the page it shows, and logs it', async () => {
        await startMain();
        await becomeReady();
        state.order = [];
        state.panelOpen = true;
        await trigger();
        // openOrFocus keeps the page (windows-panel-window.test.ts); open() would switch it.
        expect(state.order).toStrictEqual(['panels.openOrFocus sessions']);
        expect(state.logs).toContain(
          `windows: ${what}: bringing the open panel to the front`,
        );
        expect(state.logs).not.toContain(
          `windows: ${what}: opening the main panel`,
        );
      });

      it('logs a failure as an error, with no unhandled rejection', async () => {
        await startMain();
        await becomeReady();
        state.failing.add('panels.openOrFocus');
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
          await trigger();
          await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
          process.off('unhandledRejection', unhandled);
        }
        expect(state.errors).toStrictEqual([`windows: ${event} failed: EFAKE`]);
        expect(unhandled).not.toHaveBeenCalled();
      });
    },
  );

  it('waits for ready before opening a panel for an early second launch', async () => {
    await startMain();
    emit('second-instance', {}, [], '/repo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.order).not.toContain('panels.openOrFocus sessions');
    await becomeReady();
    expect(state.order.at(-1)).toBe('panels.openOrFocus sessions');
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

  it('wires the tray menu to the panel, demo mode and quit', async () => {
    await startMain();
    await becomeReady();
    state.order = [];
    state.trayActions?.openPage('packs');
    state.trayActions?.setDemo('approval');
    state.trayActions?.setDemo(null);
    state.trayActions?.quit();
    expect(state.order).toStrictEqual([
      'panels.open packs',
      'detection.setDemo approval',
      'detection.setDemo null',
      'app.quit',
    ]);
  });

  it('gives the canvas hover handler the canvas windows', async () => {
    await startMain();
    expect(state.hoverCanvas).toStrictEqual(
      expect.objectContaining({ fake: 'canvas' }),
    );
  });

  it('wires a canvas right-click to the canvas menu, for the demo session as main/detection sees it', async () => {
    await startMain();
    state.order = [];

    state.openMenu?.('codex:s1', { fake: 'canvas window' });

    expect(state.order).toStrictEqual([
      'openCanvasMenu codex:s1 {"fake":"canvas window"}',
    ]);
    const demo = state.menuArgs?.[2];
    expect(demo?.sessionKey).toBe('demo:1');

    state.order = [];
    // Its current state: the demo session's in detection's sessions section.
    expect(demo?.state()).toBe('error');
    // Picking from the menu goes to detection.setDemo, as the tray's does.
    demo?.setDemo('done');
    demo?.setDemo(null);
    expect(state.order).toStrictEqual([
      'demoStateOf ["fake sessions"]',
      'detection.setDemo done',
      'detection.setDemo null',
    ]);
  });

  it("the tray's 示範模式 check mark follows detection's demo state", async () => {
    await startMain();
    await becomeReady();
    state.order = [];

    state.demoListener?.('error');
    state.demoListener?.(null);

    expect(state.order).toStrictEqual([
      'showTrayDemoState error',
      'showTrayDemoState null',
    ]);
  });

  it("wires the application menu's 關閉面板 (⌘H) to closing the panel", async () => {
    await startMain();
    await becomeReady();
    state.order = [];
    state.menuActions?.closePanel();
    expect(state.order).toStrictEqual(['panels.close']);
  });

  it('on will-quit, writes pending settings first, then logs the quit', async () => {
    await startMain();
    expect(state.listeners.get('will-quit')).toHaveLength(2);
    state.events = [];
    emit('will-quit');
    expect(state.events).toStrictEqual(['settings flushed', 'log app: quit']);
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
