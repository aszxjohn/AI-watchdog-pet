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
 *    ~/.cursor/projects), the pool (the released sessions, from
 *    assignments.json; swept once detection's start-up sync is over), the
 *    installed character packs (userData/packs, cleaned of what an install
 *    left behind) and the pack import flow (main/packs' importer: the
 *    角色包 page's file dialog, on the panel), StageView (settings,
 *    main/windows' displays, canvas and power sections, main/detection's
 *    sessions and adapters, main/pool's pool, main/packs' packs and
 *    packImport) and the IPC handlers, and guards every window
 *    webContents. The canvas's hover and right-click handlers come
 *    once the canvas windows exist; a right-click on the demo session's
 *    square opens the demo menu, which calls detection.setDemo as the
 *    tray's 示範模式 does.
 * 3. Once ready: the session guards, the application menu, the `app://`
 *    handler, the `pack://` handler, the Dock icon hidden, the tray icon
 *    (its 示範模式 check mark follows detection, whichever menu changed
 *    it), then the stage: the canvas on the chosen display (following
 *    display and settings changes) and the sleep / lock watch (sleep also
 *    goes to detection's clock), and last the `.awpet` files held until
 *    ready (see 6).
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
import { DEMO_SESSION_KEY } from './detection/adapters/demo/demo';
import { createGeminiAdapter } from './detection/adapters/gemini/gemini';
import {
  createDetection,
  demoStateOf,
  watchDemoState,
  watchSleep,
} from './detection/detection';
import { registerIpcHandler } from './ipc/register';
import { errorCode, initRunLog, logEvent } from './log/run-log';
import { createPackImporter } from './packs/importer';
import { inspectPack } from './packs/inspect';
import { installPack } from './packs/install';
import { registerPackHandlers } from './packs/ipc';
import {
  createLaunchFileQueue,
  isPackFile,
  PACK_FILE_EXTENSION,
  packFileFromArgv,
} from './packs/launch-files';
import { handlePackProtocol } from './packs/protocol';
import { loadPacks } from './packs/store';
import { flushOnQuit } from './persist/quit';
import { registerPoolHandlers } from './pool/ipc';
import { loadPool } from './pool/store';
import { registerSettingsHandlers } from './settings/ipc';
import { loadSettings } from './settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from './stage-view/stage-view';
import {
  createCanvasWindows,
  registerCanvasContextMenuHandler,
  registerCanvasHoverHandler,
  registerCanvasReadyHandler,
} from './windows/canvas-window';
import { createDockController } from './windows/dock';
import { currentEnvironment } from './windows/environment';
import {
  buildApplicationMenu,
  openCanvasMenu,
  type DemoMenuTarget,
} from './windows/menu';
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
import { createTray, showTrayDemoState } from './windows/tray';

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
  // Startup order: run log, settings, detection, pool, packs and their
  // importer, StageView, IPC handlers, window guards; the tray and windows
  // once ready. userData is the same folder for `npm start` and the
  // packaged app.
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
  // main/pool owns the released sessions (assignments.json) and the pool
  // section. Once detection's start-up sync is over (every adapter sent
  // sync.ready or failed to start, or syncTimeoutMs passed), it drops the
  // saved releases of sessions not reported since start, except those of
  // the sources that did not confirm (still syncing, or failed to start);
  // detection knows nothing of it.
  const pool = loadPool({ file: path.join(userData, 'assignments.json') });
  detection.onSynced((reported, unconfirmed) => {
    pool.sweep(reported, unconfirmed);
  });
  // main/packs owns the installed character packs (packs/index.json and a
  // folder per pack) and the packs section; loading also removes what an
  // earlier install left behind. Its importer is the one import flow (the
  // 角色包 page's file dialog, a .awpet from outside) and owns the
  // packImport section; its dialog opens on the panel window.
  const packs = loadPacks({ dir: path.join(userData, 'packs') });
  let panelWindow: BrowserWindow | undefined;
  const importer = createPackImporter({
    store: packs,
    inspect: inspectPack,
    install: installPack,
    chooseFile: () =>
      choosePackFile(
        panelWindow === undefined || panelWindow.isDestroyed()
          ? undefined
          : panelWindow,
      ),
  });
  const stageView = createStageView({
    settings,
    windows: stageSources,
    detection,
    pool,
    packs,
    packImport: importer,
  });

  registerIpcHandler(appGetVersion, ['panels'], () => app.getVersion());
  registerSettingsHandlers(settings);
  registerPoolHandlers(pool);
  registerPackHandlers(importer);
  registerStageViewHandlers(stageView);
  registerCanvasReadyHandler();

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
  // The canvas's hover and right-click requests (AD-14). Only the demo
  // session has a canvas menu for now (its square, Epic 2 acceptance);
  // picking from it goes to detection.setDemo, as the tray's 示範模式 does.
  const demoMenu: DemoMenuTarget = {
    sessionKey: DEMO_SESSION_KEY,
    state: () => demoStateOf(detection.get().sessions),
    setDemo: (state) => {
      detection.setDemo(state);
    },
  };
  registerCanvasHoverHandler(canvas);
  registerCanvasContextMenuHandler(canvas, (sessionKey, win) => {
    openCanvasMenu(sessionKey, win, demoMenu);
  });
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
      // Only the files the installed packs declared, as `app://` above.
      startupStep('pack-protocol', () => {
        handlePackProtocol(packs);
      });
      startupStep('dock', () => {
        dock.hideAtStartup();
      });
      startupStep('tray', () => {
        createTray(process.platform, {
          openPage: (page) => {
            panels.open(page);
          },
          setDemo: (state) => {
            detection.setDemo(state);
          },
          quit: () => {
            app.quit();
          },
        });
        // The 示範模式 check mark follows detection, so it agrees with a
        // change made from the canvas menu.
        watchDemoState(detection, (state) => {
          showTrayDemoState(state);
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
