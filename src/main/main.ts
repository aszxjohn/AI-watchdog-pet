import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { appGetVersion } from '../shared/ipc';
import { registerIpcHandler } from './ipc/register';
import { initRunLog, logEvent } from './log/run-log';
import { registerSettingsHandlers } from './settings/ipc';
import { flushSettingsOnQuit, loadSettings } from './settings/store';
import {
  createStageView,
  registerStageViewHandlers,
} from './stage-view/stage-view';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Startup order: run log, settings, StageView, IPC handlers, then windows.
// userData is the same folder for `npm start` and the packaged app.
const USER_DATA = app.getPath('userData');
initRunLog(path.join(USER_DATA, 'logs'));
logEvent(
  'app',
  `start version=${app.getVersion()} platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}`,
);

/**
 * Path of a preload bundle next to main.cjs. Forge names each bundle after
 * its entry file (src/preload/panels.ts -> panels.cjs); a wrong name would
 * otherwise only show up as a missing `window.awp`. When the bundle is
 * missing, show why and exit, instead of throwing and leaving a windowless
 * process behind (showErrorBox is safe before `ready`).
 */
function preloadPath(fileName: string): string {
  const file = path.join(__dirname, fileName);
  if (!fs.existsSync(file)) {
    const reason = `Preload bundle not found: ${file}. Check the preload entries in forge.config.mts.`;
    logEvent('app', reason, 'error');
    dialog.showErrorBox('AI Watchdog Pet 無法啟動', reason);
    app.exit(1);
  }
  return file;
}

const PANELS_PRELOAD = preloadPath('panels.cjs');

const settings = loadSettings({
  file: path.join(USER_DATA, 'settings.json'),
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

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: PANELS_PRELOAD,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools in development only.
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
