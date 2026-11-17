/**
 * src/main/main.ts wiring, with electron and every module main.ts calls
 * replaced by recorders: what runs, in which order, for a Squirrel event, a
 * second instance and the primary instance. Each module's own behaviour is
 * tested in its own file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

/** What main.ts passed to createPackImporter. */
interface ImporterOptions {
  readonly store: { fake: string };
  readonly inspect: unknown;
  install(store: unknown, plan: unknown): unknown;
  chooseFile(): Promise<string | null>;
}

/** What main.ts passed to createPackExporter. */
interface ExporterOptions {
  readonly store: { fake: string };
  readonly exportPack: unknown;
  chooseTarget(defaultName: string): Promise<string | null>;
}

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
    panelOptions: undefined as
      | {
          focusApp?: () => void;
          createWindow(options: unknown): unknown;
        }
      | undefined,
    /** What main.ts passed to createPackImporter. */
    importerOptions: undefined as ImporterOptions | undefined,
    /** What main.ts passed to createPackExporter. */
    exporterOptions: undefined as ExporterOptions | undefined,
    /** The `packs:remove` callback main.ts passed to registerPackHandlers. */
    removeHandler: undefined as ((packId: string) => unknown) | undefined,
    /** What main.ts passed to registerPackSandboxHandlers. */
    sandboxHandlers: undefined as
      | {
          readEntry(packId: string): unknown;
          log(entry: unknown): void;
          readPackManifest(packId: string, version: string): unknown;
        }
      | undefined,
    /** The build folder main.ts passed to handlePackProtocol. */
    packProtocolBuildDir: undefined as unknown,
    /** The manifest reader main.ts passed to createCharacters. */
    readManifest: undefined as
      | ((packId: string, version: string) => unknown)
      | undefined,
    /** What dialog.showSaveDialog was called with, and what it answers. */
    saveDialogCalls: [] as unknown[][],
    saveDialogResult: { canceled: true, filePath: '' } as {
      canceled: boolean;
      filePath: string;
    },
    /** What dialog.showOpenDialog was called with, and what it answers. */
    dialogCalls: [] as unknown[][],
    dialogResult: { canceled: true, filePaths: [] } as {
      canceled: boolean;
      filePaths: string[];
    },
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
    menuArgs: undefined as unknown[] | undefined,
    /** The listener main.ts passed to watchDemoState. */
    demoListener: undefined as ((state: string | null) => void) | undefined,
    /** The listener main.ts passed to detection.onSynced. */
    syncedListener: undefined as
      | ((
          reported: ReadonlySet<string>,
          unconfirmed: ReadonlySet<string>,
        ) => void)
      | undefined,
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
      s.importerOptions = undefined;
      s.exporterOptions = undefined;
      s.removeHandler = undefined;
      s.sandboxHandlers = undefined;
      s.packProtocolBuildDir = undefined;
      s.readManifest = undefined;
      s.saveDialogCalls = [];
      s.saveDialogResult = { canceled: true, filePath: '' };
      s.dialogCalls = [];
      s.dialogResult = { canceled: true, filePaths: [] };
      s.displaysOptions = undefined;
      s.powerArgs = undefined;
      s.sleepArgs = undefined;
      s.hoverCanvas = undefined;
      s.openMenu = undefined;
      s.menuArgs = undefined;
      s.demoListener = undefined;
      s.syncedListener = undefined;
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
    destroyed = false;
    constructor() {
      state.order.push('new BrowserWindow');
    }
    isDestroyed() {
      return this.destroyed;
    }
  },
  dialog: {
    showErrorBox: (title: string) => {
      state.order.push(`dialog.showErrorBox ${title}`);
      state.maybeFail('dialog.showErrorBox');
    },
    showOpenDialog: async (...args: unknown[]) => {
      state.dialogCalls.push(args);
      state.maybeFail('dialog.showOpenDialog');
      return state.dialogResult;
    },
    showSaveDialog: async (...args: unknown[]) => {
      state.saveDialogCalls.push(args);
      state.maybeFail('dialog.showSaveDialog');
      return state.saveDialogResult;
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
}));

vi.mock('../../src/main/persist/quit', () => ({
  // Like the real one: a will-quit listener that writes what the store
  // (settings or pool) has pending.
  flushOnQuit: (
    app: {
      on(event: string, listener: Listener): void;
    },
    store: { fake: string },
  ) => {
    state.order.push(`flushOnQuit ${store.fake}`);
    app.on('will-quit', () => {
      state.events.push(`${store.fake} flushed`);
    });
  },
}));

vi.mock('../../src/main/pool/store', () => ({
  loadPool: (options: { file: string }) => {
    state.order.push(`loadPool ${options.file.replaceAll('\\', '/')}`);
    return { fake: 'pool' };
  },
}));

vi.mock('../../src/main/pool/assign', () => ({
  createAssigner: (options: Record<string, { fake?: string }>) => {
    state.order.push(
      `createAssigner ${Object.entries(options)
        .map(([name, source]) => `${name}=${String(source.fake)}`)
        .join(' ')}`,
    );
    return {
      fake: 'assigner',
      watchPool: () => {
        state.order.push('assigner.watchPool');
      },
      sync: (
        reported: ReadonlySet<string>,
        unconfirmed: ReadonlySet<string>,
      ) => {
        state.order.push(
          `assigner.sync ${JSON.stringify([...reported])} ${JSON.stringify([...unconfirmed])}`,
        );
      },
    };
  },
}));

vi.mock('../../src/main/packs/store', () => ({
  loadPacks: (options: { dir: string }) => {
    state.order.push(`loadPacks ${options.dir.replaceAll('\\', '/')}`);
    // `dir` is not enumerable, so the recorded sources stay as they were.
    return Object.defineProperty({ fake: 'packs' }, 'dir', {
      value: options.dir.replaceAll('\\', '/'),
      enumerable: false,
    });
  },
}));

vi.mock('../../src/main/packs/install', () => ({
  installPack: (store: { fake: string }, plan: { packId: string }) => {
    state.order.push(`installPack ${store.fake} ${plan.packId}`);
    return { ok: true, packId: plan.packId, version: '1.0.0' };
  },
}));

vi.mock('../../src/main/packs/manifest', () => ({
  readInstalledManifest: (dir: string, packId: string, version: string) => {
    state.order.push(`readInstalledManifest ${dir} ${packId} ${version}`);
    return { ok: false, code: 'unreadable', detail: 'ENOENT' };
  },
}));

vi.mock('../../src/main/settings/characters', () => ({
  createCharacters: (options: {
    settings: { fake: string };
    packs: { fake: string };
    readManifest(packId: string, version: string): unknown;
  }) => {
    state.order.push(
      `createCharacters settings=${options.settings.fake} packs=${options.packs.fake}`,
    );
    state.readManifest = options.readManifest;
    return {
      fake: 'characters',
      watch: () => {
        state.order.push('characters.watch');
      },
    };
  },
}));

vi.mock('../../src/main/packs/importer', () => ({
  createPackImporter: (options: ImporterOptions) => {
    state.order.push(`createPackImporter ${options.store.fake}`);
    state.importerOptions = options;
    return {
      fake: 'importer',
      // The file's name only: the folder is a temp folder.
      start: async (file: string) => {
        state.order.push(`importer.start ${path.basename(file)}`);
      },
    };
  },
}));

vi.mock('../../src/main/packs/exporter', () => ({
  createPackExporter: (options: ExporterOptions) => {
    state.order.push(`createPackExporter ${options.store.fake}`);
    state.exporterOptions = options;
    return { fake: 'exporter' };
  },
}));

vi.mock('../../src/main/packs/remove', () => ({
  removePack: (store: { fake: string }, packId: string) => {
    state.order.push(`removePack ${store.fake} ${packId}`);
    return { ok: true };
  },
}));

vi.mock('../../src/main/packs/ipc', () => ({
  registerPackHandlers: (
    importer: { fake: string },
    exporter: { fake: string },
    remove: (packId: string) => unknown,
  ) => {
    state.order.push(`registerPackHandlers ${importer.fake} ${exporter.fake}`);
    state.removeHandler = remove;
  },
  registerPackSandboxHandlers: (
    readEntry: (packId: string) => unknown,
    log: (entry: unknown) => void,
    readPackManifest: (packId: string, version: string) => unknown,
  ) => {
    state.order.push('registerPackSandboxHandlers');
    state.sandboxHandlers = { readEntry, log, readPackManifest };
  },
}));

vi.mock('../../src/main/packs/entry', () => ({
  readPackEntry: (store: { fake: string }, packId: string) => {
    state.order.push(`readPackEntry ${store.fake} ${packId}`);
    return Promise.resolve({ ok: false, code: 'not-installed' });
  },
}));

vi.mock('../../src/main/packs/overlay-manifest', () => ({
  readPackManifest: (
    store: { fake: string },
    packId: string,
    version: string,
  ) => {
    state.order.push(`readPackManifest ${store.fake} ${packId} ${version}`);
    return { ok: false, code: 'not-installed' };
  },
}));

vi.mock('../../src/main/packs/sandbox-log', () => ({
  logPackEntry: (entry: unknown) => {
    state.order.push(`logPackEntry ${JSON.stringify(entry)}`);
  },
}));

vi.mock('../../src/main/packs/protocol', () => ({
  handlePackProtocol: (store: { fake: string }, buildDir: unknown) => {
    state.order.push(`handlePackProtocol ${store.fake}`);
    state.packProtocolBuildDir = buildDir;
    state.maybeFail('handlePackProtocol');
  },
}));

vi.mock('../../src/main/pool/ipc', () => ({
  registerPoolHandlers: (store: { fake: string }) => {
    state.order.push(`registerPoolHandlers ${store.fake}`);
  },
}));

vi.mock('../../src/main/settings/ipc', () => ({
  registerSettingsHandlers: (
    store: { fake: string },
    stageView: { fake: string },
  ) => {
    state.order.push(
      `registerSettingsHandlers ${store.fake} ${stageView.fake}`,
    );
  },
}));

vi.mock('../../src/main/stage-view/stage-view', () => ({
  createStageView: (sources: Record<string, unknown>) => {
    state.order.push(
      `createStageView ${Object.entries(sources)
        .map(([name, source]) => `${name}=${JSON.stringify(source)}`)
        .join(' ')}`,
    );
    return {
      fake: 'stage-view',
      batch<T>(run: () => T): T {
        state.order.push('stageView.batch begins');
        try {
          return run();
        } finally {
          state.order.push('stageView.batch ends');
        }
      },
    };
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

vi.mock('../../src/main/detection/adapters/gemini/gemini', () => ({
  createGeminiAdapter: (options: { root: string }) => {
    // The real home folder's tmp folder; only its tail is checked.
    const tail = options.root.split(/[\\/]/).slice(-2).join('/');
    state.order.push(`createGeminiAdapter root=~/${tail}`);
    return { fake: 'gemini-adapter' };
  },
}));

vi.mock('../../src/main/detection/adapters/cursor/cursor', () => ({
  createCursorAdapter: (options: { root: string }) => {
    // The real home folder's projects folder; only its tail is checked.
    const tail = options.root.split(/[\\/]/).slice(-2).join('/');
    state.order.push(`createCursorAdapter root=~/${tail}`);
    return { fake: 'cursor-adapter' };
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
      onSynced: (
        listener: (
          reported: ReadonlySet<string>,
          unconfirmed: ReadonlySet<string>,
        ) => void,
      ) => {
        state.order.push('detection.onSynced');
        state.syncedListener = listener;
      },
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
  createPanelWindows: (
    options: NonNullable<typeof state.panelOptions> & { preload: string },
  ) => {
    state.panelOptions = options;
    state.order.push(
      `createPanelWindows ${options.preload.split(/[\\/]/).at(-1)}`,
    );
    return {
      open: (page: string) => {
        state.order.push(`panels.open ${page}`);
        state.maybeFail('panels.open');
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
  openCanvasMenu: (...args: unknown[]) => {
    state.order.push(
      `openCanvasMenu ${String(args[0])} ${JSON.stringify(args[1])}`,
    );
    state.menuArgs = args;
    return false;
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
    'handlePackProtocol packs',
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
      'createGeminiAdapter root=~/.gemini/tmp',
      'createCursorAdapter root=~/.cursor/projects',
      'createDetection settings={"fake":"settings"} adapters=[{"fake":"claude-code-adapter"},{"fake":"gemini-adapter"},{"fake":"cursor-adapter"}]',
      'loadPool /fake/userData/assignments.json',
      'loadPacks /fake/userData/packs',
      'createAssigner detection=detection store=pool settings=settings packs=packs',
      'detection.onSynced',
      'createPackImporter packs',
      'createPackExporter packs',
      'createCharacters settings=settings packs=packs',
      'createStageView settings={"fake":"settings"} windows={"fake":"windows-source"} assigner={"fake":"assigner"} packs={"fake":"packs"} packImport={"fake":"importer"} packExport={"fake":"exporter"} characters={"fake":"characters"}',
      'characters.watch',
      'assigner.watchPool',
      'registerIpcHandler app:get-version ["panels"]',
      'registerSettingsHandlers settings stage-view',
      'registerPoolHandlers pool',
      'registerPackHandlers importer exporter',
      'registerPackSandboxHandlers',
      'registerStageViewHandlers',
      'registerCanvasReadyHandler',
      'flushOnQuit settings',
      'flushOnQuit pool',
      'installWebContentsGuards',
      'createDockController',
      'createPanelWindows panels.cjs',
      `createCanvasWindows overlay.cjs ${process.platform}`,
      'registerCanvasHoverHandler canvas',
      'registerCanvasContextMenuHandler canvas',
    ]);
    expect(state.logs[0]).toMatch(/^app: start version=1\.0\.0 /);
  });

  it('once ready: session guards, application menu, app:// handler, pack:// handler, Dock hidden, tray, then the canvas and the power and sleep watch; no panel', async () => {
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
    ['pack-protocol', 'handlePackProtocol'],
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

  it('wires a canvas right-click to openCanvasMenu with the canvas window and nothing else: no demo menu any more (Story 3.6)', async () => {
    await startMain();
    state.order = [];

    state.openMenu?.('codex:s1', { fake: 'canvas window' });

    expect(state.order).toStrictEqual([
      'openCanvasMenu codex:s1 {"fake":"canvas window"}',
    ]);
    expect(state.menuArgs).toStrictEqual([
      'codex:s1',
      { fake: 'canvas window' },
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

  it('on will-quit, writes pending settings first, then pending releases, then logs the quit', async () => {
    await startMain();
    expect(state.listeners.get('will-quit')).toHaveLength(3);
    state.events = [];
    emit('will-quit');
    expect(state.events).toStrictEqual([
      'settings flushed',
      'pool flushed',
      'log app: quit',
    ]);
  });

  it('hands the pool’s assigner (which sweeps the pool) the keys detection reports at its start-up sync, and the sources it could not confirm', async () => {
    await startMain();
    state.order = [];

    state.syncedListener?.(
      new Set(['claude-code:a', 'demo:1']),
      new Set(['cursor']),
    );

    expect(state.order).toStrictEqual([
      'assigner.sync ["claude-code:a","demo:1"] ["cursor"]',
    ]);
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

describe('the pack export and removal (Story 3.3)', () => {
  it("exports with main/packs' exportPack, from its store", async () => {
    await startMain();
    // The copy main.ts imported (startMain reset the module registry).
    const { exportPack } = await import('../../src/main/packs/export');
    expect(state.exporterOptions?.store).toStrictEqual({ fake: 'packs' });
    expect(state.exporterOptions?.exportPack).toBe(exportPack);
  });

  it('匯出: the save dialog lists only .awpet files, starts with the name it is given, and is a sheet on the panel window', async () => {
    await startMain();
    await becomeReady();
    const win = state.panelOptions?.createWindow({});
    state.saveDialogResult = {
      canceled: false,
      filePath: '/x/sample-pack-1.0.0.awpet',
    };

    expect(
      await state.exporterOptions?.chooseTarget('sample-pack-1.0.0.awpet'),
    ).toBe('/x/sample-pack-1.0.0.awpet');
    expect(state.saveDialogCalls).toStrictEqual([
      [
        win,
        {
          title: '匯出角色包',
          defaultPath: 'sample-pack-1.0.0.awpet',
          properties: ['createDirectory', 'showOverwriteConfirmation'],
          filters: [{ name: '角色包', extensions: ['awpet'] }],
        },
      ],
    ]);
  });

  it('匯出: with no panel window (or a destroyed one) the save dialog has no parent', async () => {
    await startMain();
    await becomeReady();

    await state.exporterOptions?.chooseTarget('a-pack-1.0.0.awpet');
    const win = state.panelOptions?.createWindow({}) as {
      destroyed: boolean;
    };
    win.destroyed = true;
    await state.exporterOptions?.chooseTarget('a-pack-1.0.0.awpet');

    expect(state.saveDialogCalls.map((call) => call.length)).toStrictEqual([
      1, 1,
    ]);
  });

  it.each([
    ['canceled', { canceled: true, filePath: '' }],
    ['no path', { canceled: false, filePath: '' }],
  ])(
    '取消匯出: a save dialog answering %s answers null',
    async (_label, result) => {
      await startMain();
      await becomeReady();
      state.saveDialogResult = result;

      expect(
        await state.exporterOptions?.chooseTarget('a-pack-1.0.0.awpet'),
      ).toBeNull();
    },
  );

  it("移除: packs:remove removes from main/packs' store with removePack, in one StageView batch", async () => {
    await startMain();
    state.order = [];

    expect(state.removeHandler?.('sample-pack')).toStrictEqual({ ok: true });
    // In one StageView batch (Story 3.6): packs and characters, one delta.
    expect(state.order).toStrictEqual([
      'stageView.batch begins',
      'removePack packs sample-pack',
      'stageView.batch ends',
    ]);
  });
});

describe('the packs sandboxes (Story 3.5)', () => {
  it("packs:get-entry reads from main/packs' store; packs:log writes with logPackEntry", async () => {
    await startMain();
    state.order = [];

    expect(await state.sandboxHandlers?.readEntry('sample-pack')).toStrictEqual(
      { ok: false, code: 'not-installed' },
    );
    state.sandboxHandlers?.log({
      kind: 'sandbox-destroyed',
      packId: 'x',
      reason: 'idle',
    });
    expect(state.order).toStrictEqual([
      'readPackEntry packs sample-pack',
      'logPackEntry {"kind":"sandbox-destroyed","packId":"x","reason":"idle"}',
    ]);
  });

  it("packs:get-manifest reads from main/packs' store with readPackManifest (Story 3.6)", async () => {
    await startMain();
    state.order = [];

    expect(
      state.sandboxHandlers?.readPackManifest('sample-pack', '1.2.0'),
    ).toStrictEqual({ ok: false, code: 'not-installed' });
    expect(state.order).toStrictEqual([
      'readPackManifest packs sample-pack 1.2.0',
    ]);
  });

  it("main/settings' characters read each installed manifest with main/packs' readInstalledManifest, from the packs folder (Story 3.6)", async () => {
    await startMain();
    state.order = [];

    expect(state.readManifest?.('sample-pack', '1.2.0')).toStrictEqual({
      ok: false,
      code: 'unreadable',
      detail: 'ENOENT',
    });
    expect(state.order).toStrictEqual([
      'readInstalledManifest /fake/userData/packs sample-pack 1.2.0',
    ]);
  });

  it('the pack:// handler serves the sandbox document from the folder main runs from', async () => {
    await startMain();
    await becomeReady();

    // main.ts's own folder: next to main.cjs once built.
    expect(state.packProtocolBuildDir).toBe(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../src/main',
      ),
    );
  });
});

describe('the pack import entry points (Story 3.2)', () => {
  let dir: string;
  const realArgv = process.argv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-main-awpet-'));
  });

  afterEach(() => {
    process.argv = realArgv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** An existing file `name` in the temp folder; answers its path. */
  function file(name: string): string {
    const at = path.join(dir, name);
    fs.writeFileSync(at, 'zip');
    return at;
  }

  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** No log line names the temp folder. */
  function expectNoPathLogged(): void {
    for (const line of state.logs) {
      expect(line).not.toContain(dir);
    }
  }

  describe('the importer', () => {
    it('checks and installs with main/packs, in its store; an install runs in one StageView batch (Story 3.6)', async () => {
      await startMain();
      // The copy main.ts imported (startMain reset the module registry).
      const { inspectPack } = await import('../../src/main/packs/inspect');
      expect(state.importerOptions?.store).toStrictEqual({ fake: 'packs' });
      expect(state.importerOptions?.inspect).toBe(inspectPack);
      state.order = [];

      expect(
        state.importerOptions?.install(
          { fake: 'packs' },
          { packId: 'sample-pack' },
        ),
      ).toStrictEqual({ ok: true, packId: 'sample-pack', version: '1.0.0' });
      expect(state.order).toStrictEqual([
        'stageView.batch begins',
        'installPack packs sample-pack',
        'stageView.batch ends',
      ]);
    });

    it('選檔: the file dialog lists only .awpet files, one file, as a sheet on the panel window', async () => {
      await startMain();
      await becomeReady();
      const win = state.panelOptions?.createWindow({});
      state.dialogResult = { canceled: false, filePaths: ['/x/a.awpet'] };

      expect(await state.importerOptions?.chooseFile()).toBe('/x/a.awpet');
      expect(state.dialogCalls).toStrictEqual([
        [
          win,
          {
            title: '匯入角色包',
            properties: ['openFile'],
            filters: [{ name: '角色包', extensions: ['awpet'] }],
          },
        ],
      ]);
    });

    it('選檔: with no panel window (or a destroyed one) the dialog has no parent', async () => {
      await startMain();
      await becomeReady();

      await state.importerOptions?.chooseFile();
      const win = state.panelOptions?.createWindow({}) as {
        destroyed: boolean;
      };
      win.destroyed = true;
      await state.importerOptions?.chooseFile();

      expect(state.dialogCalls.map((call) => call.length)).toStrictEqual([
        1, 1,
      ]);
    });

    it('取消選檔: a cancelled dialog answers null', async () => {
      await startMain();
      await becomeReady();
      state.dialogResult = { canceled: true, filePaths: [] };

      expect(await state.importerOptions?.chooseFile()).toBeNull();
    });
  });

  describe('I/O matrix', () => {
    it('第二實例: a .awpet in a second launch is imported once ready, with the panel opened on 角色包 (not brought up on its page)', async () => {
      const pack = file('sample.awpet');
      await startMain();
      await becomeReady();
      state.order = [];

      emit('second-instance', {}, ['electron', '.', pack], '/repo');
      await settle();

      expect(state.order).toStrictEqual([
        'importer.start sample.awpet',
        'panels.open packs',
      ]);
      expect(state.logs).toContain(
        'packs: second-instance: a .awpet to import',
      );
      expect(state.errors).toStrictEqual([]);
      expectNoPathLogged();
    });

    it('第二實例: a relative path is taken from its working folder; only the first .awpet counts', async () => {
      file('first.awpet');
      file('second.awpet');
      await startMain();
      await becomeReady();
      state.order = [];

      emit(
        'second-instance',
        {},
        ['app.exe', '--flag', 'first.awpet', 'second.awpet'],
        dir,
      );
      await settle();

      expect(state.order).toStrictEqual([
        'importer.start first.awpet',
        'panels.open packs',
      ]);
    });

    it('第二實例: one before ready waits for it', async () => {
      const pack = file('early.awpet');
      await startMain();
      emit('second-instance', {}, [pack], '/repo');
      await settle();
      expect(state.order).not.toContain('importer.start early.awpet');

      await becomeReady();

      expect(state.order.slice(-2)).toStrictEqual([
        'importer.start early.awpet',
        'panels.open packs',
      ]);
    });

    it('第二實例: a panel that fails to open is logged; the import still starts', async () => {
      const pack = file('sample.awpet');
      await startMain();
      await becomeReady();
      state.failing.add('panels.open');
      state.order = [];

      emit('second-instance', {}, [pack], '/repo');
      await settle();

      expect(state.order).toStrictEqual([
        'importer.start sample.awpet',
        'panels.open packs',
      ]);
      expect(state.errors).toStrictEqual([
        'windows: opening the panel for a .awpet failed: EFAKE',
      ]);
    });

    it('不是 .awpet: other arguments, a missing .awpet, a folder named .awpet or another file only bring the panel up, as before', async () => {
      fs.mkdirSync(path.join(dir, 'folder.awpet'));
      const other = file('notes.txt');
      await startMain();
      await becomeReady();
      state.order = [];

      emit(
        'second-instance',
        {},
        [
          'electron',
          '.',
          other,
          path.join(dir, 'missing.awpet'),
          path.join(dir, 'folder.awpet'),
          '--open=x.awpet',
        ],
        dir,
      );
      await settle();

      expect(state.order).toStrictEqual(['panels.openOrFocus sessions']);
      expect(state.logs.join('\n')).not.toContain('a .awpet to import');
    });

    it('啟動參數: a .awpet in the first launch arguments is imported once ready, the panel opened on 角色包', async () => {
      const pack = file('launch.awpet');
      process.argv = ['/Applications/App', pack];
      await startMain();
      expect(state.order).not.toContain('importer.start launch.awpet');
      state.order = [];

      await becomeReady();

      expect(state.order).toStrictEqual([
        ...readySteps(),
        'importer.start launch.awpet',
        'panels.open packs',
      ]);
      expect(state.logs).toContain(
        'packs: launch arguments: a .awpet to import',
      );
      expectNoPathLogged();
    });

    it('啟動參數: without a .awpet nothing is imported and no panel opens', async () => {
      process.argv = ['/Applications/App', file('notes.txt')];
      await startMain();
      state.order = [];

      await becomeReady();

      expect(state.order).toStrictEqual(readySteps());
    });

    it('open-file: before ready it is held, preventDefault called, and imported once ready', async () => {
      const pack = file('opened.awpet');
      await startMain();
      const preventDefault = vi.fn();

      emit('open-file', { preventDefault }, pack);
      await settle();

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(state.order).not.toContain('importer.start opened.awpet');
      state.order = [];
      await becomeReady();
      expect(state.order).toStrictEqual([
        ...readySteps(),
        'importer.start opened.awpet',
        'panels.open packs',
      ]);
      expect(state.logs).toContain('packs: open-file: a .awpet to import');
      expectNoPathLogged();
    });

    it('open-file: after ready it is imported at once', async () => {
      const pack = file('opened.awpet');
      await startMain();
      await becomeReady();
      state.order = [];
      const preventDefault = vi.fn();

      emit('open-file', { preventDefault }, pack);

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(state.order).toStrictEqual([
        'importer.start opened.awpet',
        'panels.open packs',
      ]);
    });

    it('open-file: a file that is not a .awpet is ignored with one line (still preventDefault)', async () => {
      const other = file('notes.txt');
      await startMain();
      await becomeReady();
      state.order = [];
      const preventDefault = vi.fn();

      emit('open-file', { preventDefault }, other);

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(state.order).toStrictEqual([]);
      expect(state.logs).toContain(
        'packs: open-file: not a .awpet file; ignored',
      );
      expectNoPathLogged();
    });
  });
});
