/**
 * Electron main entry.
 *
 * 1. A Squirrel install/update/uninstall event, or a second instance (the
 *    single-instance lock is taken), quits right here and initialises
 *    nothing: no run log, no settings, no IPC (NFR10). Otherwise it could
 *    rename a broken settings.json or write to the running instance's log
 *    before exiting. Only the second instance says why, on the console.
 * 2. The primary instance registers the `app` and `pack` schemes (before
 *    `ready`), then starts the run log, settings, detection (demo mode off;
 *    the Claude Code adapter reading ~/.claude/projects, the Gemini CLI
 *    adapter reading ~/.gemini/tmp, the Cursor adapter reading
 *    ~/.cursor/projects), the pool (the released sessions and the saved
 *    assignments, from assignments.json), the installed character packs
 *    (userData/packs, cleaned of what an install left behind), the pool's
 *    assigner (a character for each shown session; it sweeps the pool
 *    once detection's start-up sync is over), the pack import flow
 *    (main/packs' importer: the 角色包 page's file dialog, on the panel)
 *    and export flow (main/packs' exporter: the save dialog, on the
 *    panel), main/settings' characters (each installed character's
 *    effective parameters, from its pack's installed manifest), StageView
 *    (settings and characters, main/windows' displays, canvas and power
 *    sections, main/pool's assigner's sessions, adapters, pool and actors,
 *    main/packs' packs, packImport and packExport), main/pool's demo mode
 *    (the tray's 示範模式 goes through it) and the IPC handlers
 *    (a settings patch, an install and a removal each run in one StageView
 *    batch; removing a pack among them; the overlay's packs' entries and
 *    sandbox log lines, and what it draws each pack with), and guards
 *    every window webContents. The canvas's hover, right-click and WebGL
 *    context handlers come once the canvas windows exist; no right-click
 *    opens a menu yet (a character's menu is Story 4.3), and demo mode is
 *    switched from the tray's 示範模式 only, through main/pool's demo mode.
 *    A GPU process that goes away is logged (Story 3.6).
 * 3. Once ready: the session guards, the application menu, the `app://`
 *    handler, the `pack://` handler (with the sandbox document the build
 *    wrote next to main.cjs), the Dock icon hidden, the tray icon
 *    (its 示範模式 submenu built again on each change of demo mode, which
 *    pops its character question up from the icon), then the stage: the
 *    canvas on the chosen display (following
 *    display and settings changes) and the sleep / lock watch (sleep also
 *    goes to detection's clock), and last the `.awpet` files held until
 *    ready (see 6). On macOS, hiding the whole app hides the canvas too
 *    (accepted in Story 3.6: see canvas-window.ts).
 *    Each step that throws is logged as an error with its errorCode and the
 *    next one still runs, so a failure in any other step does not stop the
 *    tray from being created; only the session guards are different:
 *    without them no window may open, so the app says why and exits.
 *    Anything else that throws once ready is logged too.
 * 4. No panel opens at startup; the tray menu opens it on a page. A second
 *    launch and macOS `activate` bring an open panel to the front on the
 *    page it shows, or open the main panel when none is open; a failure
 *    there is logged too.
 * 5. Closing every window keeps the app running; only the tray menu's 結束
 *    quits, and settings, then released sessions, still waiting for their
 *    debounce are written first.
 *    Quitting stops the canvas and detection (and with it the Claude
 *    Code, Gemini CLI and Cursor adapters' watchers).
 * 6. A `.awpet` handed from outside goes through the same import as the
 *    角色包 page's button, and opens the panel on 角色包: one in a second
 *    launch's arguments (instead of 4), one in the first launch's
 *    arguments, and a macOS `open-file` (always `preventDefault`ed; a file
 *    that is not a `.awpet` is ignored). Those that come before `ready`
 *    wait for it (main/packs/launch-files.ts). Arguments with no `.awpet`
 *    (other switches, files, paths that do not exist) change nothing.
 */
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerMonitor,
  screen,
  session,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { PRODUCT_NAME } from '../shared/constants';
import { appGetVersion } from '../shared/ipc';
import { MAIN_PANEL_PAGE, type PanelPageId } from '../shared/panels';
import { createClaudeCodeAdapter } from './detection/adapters/claude-code/claude-code';
import { createCursorAdapter } from './detection/adapters/cursor/cursor';
import { createGeminiAdapter } from './detection/adapters/gemini/gemini';
import { createDetection, watchSleep } from './detection/detection';
import { registerIpcHandler } from './ipc/register';
import { errorCode, initRunLog, logEvent } from './log/run-log';
import { exportPack } from './packs/export';
import { createPackExporter } from './packs/exporter';
import { createPackImporter } from './packs/importer';
import { inspectPack } from './packs/inspect';
import { installPack } from './packs/install';
import { readPackEntry } from './packs/entry';
import { registerPackHandlers, registerPackSandboxHandlers } from './packs/ipc';
import {
  createLaunchFileQueue,
  isPackFile,
  PACK_FILE_EXTENSION,
  packFileFromArgv,
} from './packs/launch-files';
import { readInstalledManifest } from './packs/manifest';
import { readPackManifest } from './packs/overlay-manifest';
import { handlePackProtocol } from './packs/protocol';
import { removePack } from './packs/remove';
import { logPackEntry } from './packs/sandbox-log';
import { loadPacks } from './packs/store';
import { flushOnQuit } from './persist/quit';
import { createAssigner } from './pool/assign';
import { createDemoMode } from './pool/demo-mode';
import { registerPoolHandlers } from './pool/ipc';
import { loadPool } from './pool/store';
import { createCharacters } from './settings/characters';
import { registerSettingsHandlers } from './settings/ipc';
import { loadSettings } from './settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from './stage-view/stage-view';
import {
  createCanvasWindows,
  registerCanvasContextMenuHandler,
  registerCanvasGpuHandler,
  registerCanvasHoverHandler,
  registerCanvasReadyHandler,
} from './windows/canvas-window';
import { createDockController } from './windows/dock';
import { currentEnvironment } from './windows/environment';
import { watchGpuProcess } from './windows/gpu';
import { buildApplicationMenu, openCanvasMenu } from './windows/menu';
import { createPanelWindows, PRELOAD_BUNDLES } from './windows/panel-window';
import { watchPower } from './windows/power';
import { handleAppProtocol, registerSchemes } from './windows/protocols';
import {
  installSessionGuards,
  installWebContentsGuards,
} from './windows/security';
import {
  createWindowsStageSource,
  watchDisplays,
} from './windows/stage-sources';
import { createTray, popUpDemoCharacters, showTrayDemo } from './windows/tray';

if (started) {
  // A Squirrel event: quit silently.
  app.quit();
} else if (!app.requestSingleInstanceLock()) {
  // Console only: the run log belongs to the instance holding the lock.
  console.info(
    '[app] another instance holds the single-instance lock (it brings up its panel); exiting',
  );
  app.quit();
} else {
  registerSchemes();
  startPrimaryInstance();
}

/**
 * Logs why the app cannot start, shows it, and exits, instead of leaving a
 * windowless process behind (showErrorBox is safe before `ready`).
 */
function exitBecause(reason: string): void {
  logEvent('app', reason, 'error');
  dialog.showErrorBox(`${PRODUCT_NAME} 無法啟動`, reason);
  app.exit(1);
}

/**
 * Path of a preload bundle next to main.cjs. When the bundle is missing,
 * show why and exit.
 */
function preloadPath(fileName: string): string {
  const file = path.join(__dirname, fileName);
  if (!fs.existsSync(file)) {
    exitBecause(
      `Preload bundle not found: ${file}. Check the preload entries in forge.config.mts.`,
    );
  }
  return file;
}

/** The panel page a `.awpet` from outside opens. */
const PACKS_PAGE: PanelPageId = 'packs';

/**
 * The 匯入角色包… file dialog: a sheet on the panel when one is open, only
 * `.awpet` files, one file. Answers the file picked, or null when
 * cancelled.
 */
async function choosePackFile(
  parent: BrowserWindow | undefined,
): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '匯入角色包',
    properties: ['openFile'],
    filters: [{ name: '角色包', extensions: [PACK_FILE_EXTENSION.slice(1)] }],
  };
  const result =
    parent === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * The 匯出… save dialog: a sheet on the panel when one is open, only
 * `.awpet` files, `defaultName` as the file name to start with (in the
 * folder the system picks). Asks before replacing a file (on Linux too).
 * Answers the place picked, or null when cancelled.
 */
async function choosePackTarget(
  parent: BrowserWindow | undefined,
  defaultName: string,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: '匯出角色包',
    defaultPath: defaultName,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
    filters: [{ name: '角色包', extensions: [PACK_FILE_EXTENSION.slice(1)] }],
  };
  const result =
    parent === undefined
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(parent, options);
  return result.canceled || result.filePath === '' ? null : result.filePath;
}

/**
 * Runs one startup step after `ready`. A step that throws is logged with its
 * name and errorCode, and the caller goes on with the next one: a missing
 * feature beats a missing tray.
 */
function startupStep(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    logEvent(
      'app',
      `startup step ${name} failed: ${errorCode(error)}`,
      'error',
    );
  }
}

function startPrimaryInstance(): void {
  // Startup order: run log, settings, detection, pool, packs, the pool's
  // assigner, the packs' importer and exporter, the characters, StageView,
  // IPC handlers, window guards; the tray and windows once ready. userData
  // is the same folder for `npm start` and the packaged app.
  const userData = app.getPath('userData');
  initRunLog(path.join(userData, 'logs'));
  logEvent(
    'app',
    `start version=${app.getVersion()} platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}`,
  );

  const panelsPreload = preloadPath(PRELOAD_BUNDLES.panels);
  const overlayPreload = preloadPath(PRELOAD_BUNDLES.overlay);

  const settings = loadSettings({
    file: path.join(userData, 'settings.json'),
  });
  // main/windows owns the displays, canvas and power sections; until ready
  // they are empty, null and false.
  const stageSources = createWindowsStageSource();
  // main/detection owns the sessions and adapters sections. It needs no
  // Electron API, so it starts here: syncTimeoutMs counts from now. The
  // Claude Code, Gemini CLI and Cursor adapters read the real home folder's
  // transcripts and chat logs.
  const detection = createDetection({
    settings,
    adapters: [
      createClaudeCodeAdapter({
        root: path.join(os.homedir(), '.claude', 'projects'),
      }),
      createGeminiAdapter({
        root: path.join(os.homedir(), '.gemini', 'tmp'),
      }),
      createCursorAdapter({
        root: path.join(os.homedir(), '.cursor', 'projects'),
      }),
    ],
  });
  // main/pool owns the released sessions and the saved assignments
  // (assignments.json).
  const pool = loadPool({ file: path.join(userData, 'assignments.json') });
  // main/packs owns the installed character packs (packs/index.json and a
  // folder per pack) and the packs section; loading also removes what an
  // earlier install left behind. Its importer is the one import flow (the
  // 角色包 page's file dialog, a .awpet from outside) and owns the
  // packImport section; its exporter (each pack's 匯出…) owns the
  // packExport section. Both dialogs open on the panel window. Removing a
  // pack (its 移除…) is one quick call, answered by packs:remove itself.
  const packs = loadPacks({ dir: path.join(userData, 'packs') });
  // main/pool's assigner gives each shown session a character from the
  // pool (上場 packs, 加入池子 characters) and owns the pool and actors
  // sections, passing detection's sessions and adapters on with them.
  // Once detection's start-up sync is over (every adapter sent sync.ready
  // or failed to start, or syncTimeoutMs passed), it sweeps the saved
  // releases and assignments of sessions not reported since start (except
  // those of the sources that did not confirm: still syncing, or failed to
  // start) and assigns every session due a character; detection knows
  // nothing of it. It follows settings and packs once StageView exists
  // (watchPool, below).
  const assigner = createAssigner({ detection, store: pool, settings, packs });
  detection.onSynced((reported, unconfirmed) => {
    assigner.sync(reported, unconfirmed);
  });
  let panelWindow: BrowserWindow | undefined;
  /** The panel window, while one is open: the dialogs' parent. */
  function openPanelWindow(): BrowserWindow | undefined {
    return panelWindow === undefined || panelWindow.isDestroyed()
      ? undefined
      : panelWindow;
  }
  // An install runs in one StageView batch (created below; an install
  // comes only later, from the panel or a .awpet from outside), so the
  // packs section, the characters and the actors it changes are one delta.
  const importer = createPackImporter({
    store: packs,
    inspect: inspectPack,
    install: (store, plan) => stageView.batch(() => installPack(store, plan)),
    chooseFile: () => choosePackFile(openPanelWindow()),
  });
  const exporter = createPackExporter({
    store: packs,
    exportPack,
    chooseTarget: (defaultName) =>
      choosePackTarget(openPanelWindow(), defaultName),
  });
  // main/settings works out each installed character's effective
  // parameters and fixed parameters (the characters section), from the
  // pack's installed manifest, which main/packs reads for it.
  const characters = createCharacters({
    settings,
    packs,
    readManifest: (packId, version) =>
      readInstalledManifest(packs.dir, packId, version),
  });
  const stageView = createStageView({
    settings,
    windows: stageSources,
    assigner,
    packs,
    packImport: importer,
    packExport: exporter,
    characters,
  });
  // Only now do the characters and the assigner follow settings and the
  // installed packs: StageView hears a settings or packs change first, so
  // what that change brings never reaches a renderer ahead of it. The
  // characters first, so a new character's values come before an actor
  // that plays it.
  characters.watch();
  assigner.watchPool();
  // main/pool's demo mode (FR21 as changed on 2026-11-24): the tray's
  // 示範模式 goes through it. It has the stage to itself while on (the
  // assigner parks every other session's actor), and each switch is one
  // StageView batch. It follows the installed packs and settings from now
  // on, after StageView, for the same reason as above.
  const demoMode = createDemoMode({
    detection,
    assigner,
    settings,
    packs,
    chooseCharacter: (choices, pick) => {
      popUpDemoCharacters(choices, pick);
    },
    batch: (run) => {
      stageView.batch(run);
    },
  });
  demoMode.watch();

  registerIpcHandler(appGetVersion, ['panels'], () => app.getVersion());
  registerSettingsHandlers(settings, stageView);
  registerPoolHandlers(pool);
  // A removal runs in one StageView batch too: its characters never leave
  // in a delta of their own.
  registerPackHandlers(importer, exporter, (packId) =>
    stageView.batch(() => removePack(packs, packId)),
  );
  // The overlay's: each pack's entry for its sandbox, the run log lines
  // about the sandboxes (Story 3.5), and what it draws each pack with
  // (Story 3.6).
  registerPackSandboxHandlers(
    (packId) => readPackEntry(packs, packId),
    logPackEntry,
    (packId, version) => readPackManifest(packs, packId, version),
  );
  registerStageViewHandlers(stageView);
  // Each report is logged; a canvas that did not initialise after a
  // recovery is tried again (the canvas windows, created below, exist by
  // the time any page can report).
  registerCanvasReadyHandler({
    ready: (webContentsId, report) => {
      canvas.ready(webContentsId, report);
    },
  });

  // Write settings, then released sessions, that are still waiting for
  // their debounce before exiting, then log the quit (will-quit listeners
  // run in the order they were added).
  flushOnQuit(app, settings);
  flushOnQuit(app, pool);
  app.on('will-quit', () => {
    logEvent('app', 'quit');
  });

  const env = currentEnvironment();
  installWebContentsGuards(app, env);

  const dock = createDockController({
    platform: process.platform,
    dock: app.dock,
  });
  const panels = createPanelWindows({
    createWindow: (options) => {
      panelWindow = new BrowserWindow(options);
      return panelWindow;
    },
    preload: panelsPreload,
    env,
    dock,
    focusApp:
      process.platform === 'darwin'
        ? () => {
            app.focus({ steal: true });
          }
        : undefined,
  });
  const canvas = createCanvasWindows({
    createWindow: (options) => new BrowserWindow(options),
    preload: overlayPreload,
    env,
    platform: process.platform,
  });
  // The canvas's hover and right-click requests (AD-14). No character has
  // a canvas menu yet (Story 4.3), so a right-click opens none.
  registerCanvasHoverHandler(canvas);
  registerCanvasContextMenuHandler(canvas, (sessionKey, win) => {
    openCanvasMenu(sessionKey, win);
  });
  // The canvas's WebGL context (Story 3.6): its page is reloaded when the
  // context is not restored in time. A GPU process that goes away is only
  // logged: the canvas comes back through its context.
  registerCanvasGpuHandler(canvas);
  watchGpuProcess(app);
  // Quitting closes the canvas with every other window; do not rebuild it.
  app.on('before-quit', () => {
    canvas.stop();
  });
  // Detection stops too: no more timers, no more StageView pushes, and the
  // Claude Code, Gemini CLI and Cursor adapters' watchers close. Its own
  // listener, so a throwing canvas.stop() cannot skip it.
  app.on('before-quit', () => {
    detection.stop();
  });

  /**
   * A second launch or macOS `activate`, once ready: brings the open panel
   * to the front on the page it shows (an unsaved page is not thrown away),
   * or opens the main panel when none is open. A failure is logged.
   */
  function showPanelOn(event: string, what: string): void {
    void app
      .whenReady()
      .then(() => {
        logEvent(
          'windows',
          panels.isOpen()
            ? `${what}: bringing the open panel to the front`
            : `${what}: opening the main panel`,
        );
        panels.openOrFocus(MAIN_PANEL_PAGE);
      })
      .catch((error: unknown) => {
        logEvent('windows', `${event} failed: ${errorCode(error)}`, 'error');
      });
  }
  // A .awpet from outside (6): imported once ready, the panel on 角色包.
  const launchFiles = createLaunchFileQueue(
    (file) => {
      void importer.start(file);
      panels.open(PACKS_PAGE);
    },
    (error) => {
      logEvent(
        'windows',
        `opening the panel for a .awpet failed: ${errorCode(error)}`,
        'error',
      );
    },
  );
  function importFromOutside(from: string, file: string): void {
    logEvent('packs', `${from}: a .awpet to import`);
    launchFiles.add(file);
  }
  const launchFile = packFileFromArgv(process.argv, process.cwd());
  if (launchFile !== null) {
    importFromOutside('launch arguments', launchFile);
  }
  // A second launch (any platform; macOS only when started from a shell):
  // a .awpet in its arguments is imported; otherwise the panel comes up.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const file = packFileFromArgv(argv, workingDirectory);
    if (file === null) {
      showPanelOn('second-instance', 'second instance launched');
      return;
    }
    importFromOutside('second-instance', file);
  });
  // macOS: a file dropped on the Dock icon or opened with the app, maybe
  // before ready. Handled here, so the system does not report a failure.
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (!isPackFile(file)) {
      logEvent('packs', 'open-file: not a .awpet file; ignored');
      return;
    }
    importFromOutside('open-file', file);
  });
  // macOS: launching the running app again (Finder, Spotlight) or clicking
  // its Dock icon. An open panel comes to the front on the page it shows;
  // otherwise the main panel opens. This replaces Story 1.5's 再啟動一次
  // behaviour, which always switched to the main panel (Epic 1 retro A7).
  app.on('activate', () => {
    showPanelOn('activate', 'app activated');
  });
  // Stay resident with no window open; only the tray menu quits.
  app.on('window-all-closed', () => {});

  // Session guards first: if they cannot be installed, no window opens
  // (no tray, no canvas) and the app says why and exits. Then the
  // application menu before any window can open, and the canvas after the
  // app:// handler it loads from; each of these may fail on its own.
  void app
    .whenReady()
    .then(() => {
      try {
        installSessionGuards(session.defaultSession, env);
      } catch (error) {
        exitBecause(
          `startup step session-guards failed: ${errorCode(error)}. No window may open without the session guards, so the app exits.`,
        );
        return;
      }
      startupStep('menu', () => {
        Menu.setApplicationMenu(
          buildApplicationMenu(process.platform, {
            closePanel: () => {
              panels.close();
            },
          }),
        );
      });
      startupStep('app-protocol', () => {
        handleAppProtocol(__dirname);
      });
      // Only the files the installed packs declared, as `app://` above,
      // and the sandbox document the build wrote next to main.cjs.
      startupStep('pack-protocol', () => {
        handlePackProtocol(packs, __dirname);
      });
      startupStep('dock', () => {
        dock.hideAtStartup();
      });
      startupStep('tray', () => {
        createTray(
          process.platform,
          {
            openPage: (page) => {
              panels.open(page);
            },
            pickDemoCharacter: (key) => {
              demoMode.pickCharacter(key);
            },
            pickDemoState: (state) => {
              demoMode.pickState(state);
            },
            stopDemo: () => {
              demoMode.stop();
            },
            quit: () => {
              app.quit();
            },
          },
          demoMode.view(),
        );
        // The 示範模式 submenu is built again on each change of demo mode.
        demoMode.onChange((view) => {
          showTrayDemo(view);
        });
      });
      startupStep('canvas', () => {
        watchDisplays({ screen, settings, source: stageSources, canvas });
      });
      startupStep('power', () => {
        watchPower(powerMonitor, stageSources);
      });
      // Its own step, so a failing watchPower cannot leave detection's
      // clock without sleep compensation.
      startupStep('sleep', () => {
        watchSleep(powerMonitor, detection);
      });
      // Last: the .awpet files that came before ready, now that the panel
      // can open.
      startupStep('launch-files', () => {
        launchFiles.ready();
      });
    })
    .catch((error: unknown) => {
      // Something outside a step threw (exitBecause included).
      logEvent('app', `startup failed: ${errorCode(error)}`, 'error');
    });
}
