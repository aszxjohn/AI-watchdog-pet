import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { appGetVersion } from '../shared/ipc';
import { registerIpcHandler } from './ipc/register';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

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
    console.error(reason);
    dialog.showErrorBox('AI Watchdog Pet 無法啟動', reason);
    app.exit(1);
  }
  return file;
}

const PANELS_PRELOAD = preloadPath('panels.cjs');

registerIpcHandler(appGetVersion, () => app.getVersion());

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
