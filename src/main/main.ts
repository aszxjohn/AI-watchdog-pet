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
 *    the Claude Code adapter reading ~/.claude/projects),
 *    StageView (settings, main/windows' displays, canvas and power sections,
 *    and main/detection's sessions and adapters) and the IPC handlers, and
 *    guards every window webContents. The canvas's hover and right-click
 *    handlers come once the canvas windows exist; a right-click on the demo
 *    session's square opens the demo menu, which calls detection.setDemo
 *    as the tray's 示範模式 does.
 * 3. Once ready: the session guards, the application menu, the `app://`
 *    handler, the Dock icon hidden, the tray icon (its 示範模式 check mark
 *    follows detection, whichever menu changed it), then the stage: the
 *    canvas on the chosen display (following display and settings changes)
 *    and the sleep / lock watch (sleep also goes to detection's clock).
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
 *    quits, and settings still waiting for their debounce are written first.
 *    Quitting stops the canvas and detection (and with it the Claude Code
 *    adapter's watcher).
 */
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerMonitor,
  screen,
  session,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { PRODUCT_NAME } from '../shared/constants';
import { appGetVersion } from '../shared/ipc';
import { MAIN_PANEL_PAGE } from '../shared/panels';
import { createClaudeCodeAdapter } from './detection/adapters/claude-code/claude-code';
import { DEMO_SESSION_KEY } from './detection/adapters/demo/demo';
import {
  createDetection,
  demoStateOf,
  watchDemoState,
  watchSleep,
} from './detection/detection';
import { registerIpcHandler } from './ipc/register';
import { errorCode, initRunLog, logEvent } from './log/run-log';
import { registerSettingsHandlers } from './settings/ipc';
import { flushSettingsOnQuit, loadSettings } from './settings/store';
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
  // Startup order: run log, settings, StageView, IPC handlers, window
  // guards; the tray and windows once ready. userData is the same folder
  // for `npm start` and the packaged app.
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
  // Claude Code adapter reads the real home folder's transcripts.
  const detection = createDetection({
    settings,
    adapters: [
      createClaudeCodeAdapter({
        root: path.join(os.homedir(), '.claude', 'projects'),
      }),
    ],
  });
  const stageView = createStageView({
    settings,
    windows: stageSources,
    detection,
  });

  registerIpcHandler(appGetVersion, ['panels'], () => app.getVersion());
  registerSettingsHandlers(settings);
  registerStageViewHandlers(stageView);
  registerCanvasReadyHandler();

  // Write settings that are still waiting for their debounce before exiting,
  // then log the quit (will-quit listeners run in the order they were added).
  flushSettingsOnQuit(app, settings);
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
    createWindow: (options) => new BrowserWindow(options),
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
  // Claude Code adapter's watcher closes. Its own listener, so a throwing
  // canvas.stop() cannot skip it.
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
  // A second launch (any platform; macOS only when started from a shell).
  app.on('second-instance', () => {
    showPanelOn('second-instance', 'second instance launched');
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
    })
    .catch((error: unknown) => {
      // Something outside a step threw (exitBecause included).
      logEvent('app', `startup failed: ${errorCode(error)}`, 'error');
    });
}
