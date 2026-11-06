/**
 * Electron main entry.
 *
 * 1. A Squirrel install/update/uninstall event, or a second instance (the
 *    single-instance lock is taken), quits right here and initialises
 *    nothing: no run log, no settings, no IPC (NFR10). Otherwise it could
 *    rename a broken settings.json or write to the running instance's log
 *    before exiting. Only the second instance says why, on the console.
 * 2. The primary instance registers the `app` and `pack` schemes (before
 *    `ready`), then starts the run log, settings, StageView and the IPC
 *    handlers, and guards every window webContents.
 * 3. Once ready: the session guards, the application menu, the `app://`
 *    handler, the Dock icon hidden, the tray icon. No window opens at
 *    startup; the tray menu, a second launch and macOS `activate` open the
 *    panel.
 * 4. Closing every window keeps the app running; only the tray menu's 結束
 *    quits, and settings still waiting for their debounce are written first.
 */
import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { PRODUCT_NAME } from '../shared/constants';
import { appGetVersion } from '../shared/ipc';
import { MAIN_PANEL_PAGE } from '../shared/panels';
import { registerIpcHandler } from './ipc/register';
import { initRunLog, logEvent } from './log/run-log';
import { registerSettingsHandlers } from './settings/ipc';
import { flushSettingsOnQuit, loadSettings } from './settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from './stage-view/stage-view';
import { createDockController } from './windows/dock';
import { currentEnvironment } from './windows/environment';
import { buildApplicationMenu } from './windows/menu';
import { createPanelWindows, PRELOAD_BUNDLES } from './windows/panel-window';
import { handleAppProtocol, registerSchemes } from './windows/protocols';
import {
  installSessionGuards,
  installWebContentsGuards,
} from './windows/security';
import { createTray } from './windows/tray';

if (started) {
  // A Squirrel event: quit silently.
  app.quit();
} else if (!app.requestSingleInstanceLock()) {
  // Console only: the run log belongs to the instance holding the lock.
  console.info(
    '[app] another instance holds the single-instance lock (it opens its main panel); exiting',
  );
  app.quit();
} else {
  registerSchemes();
  startPrimaryInstance();
}

/**
 * Path of a preload bundle next to main.cjs. When the bundle is missing,
 * show why and exit, instead of throwing and leaving a windowless process
 * behind (showErrorBox is safe before `ready`).
 */
function preloadPath(fileName: string): string {
  const file = path.join(__dirname, fileName);
  if (!fs.existsSync(file)) {
    const reason = `Preload bundle not found: ${file}. Check the preload entries in forge.config.mts.`;
    logEvent('app', reason, 'error');
    dialog.showErrorBox(`${PRODUCT_NAME} 無法啟動`, reason);
    app.exit(1);
  }
  return file;
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

  const settings = loadSettings({
    file: path.join(userData, 'settings.json'),
  });
  const stageView = createStageView({ settings });

  registerIpcHandler(appGetVersion, () => app.getVersion());
  registerSettingsHandlers(settings);
  registerStageViewHandlers(stageView);

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

  // A second launch (any platform; macOS only when started from a shell)
  // opens the main panel in this instance.
  app.on('second-instance', () => {
    void app.whenReady().then(() => {
      logEvent('windows', 'second instance launched: opening the main panel');
      panels.open(MAIN_PANEL_PAGE);
    });
  });
  // macOS: launching the running app again (Finder, Spotlight) or clicking
  // its Dock icon. Like a second launch (I/O matrix 再啟動一次), this opens
  // the main panel, or switches the open panel to it and brings it forward.
  app.on('activate', () => {
    void app.whenReady().then(() => {
      logEvent('windows', 'app activated: opening the main panel');
      panels.open(MAIN_PANEL_PAGE);
    });
  });
  // Stay resident with no window open; only the tray menu quits.
  app.on('window-all-closed', () => {});

  // Session guards first, so a failure further down cannot leave a panel
  // without them; the application menu before any window can open.
  void app.whenReady().then(() => {
    installSessionGuards(session.defaultSession, env);
    Menu.setApplicationMenu(buildApplicationMenu(process.platform));
    handleAppProtocol(__dirname);
    dock.hideAtStartup();
    createTray(process.platform, {
      openPage: (page) => {
        panels.open(page);
      },
      quit: () => {
        app.quit();
      },
    });
  });
}
