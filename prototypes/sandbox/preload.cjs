'use strict';

// Overlay preload for the Story 1.2 sandbox prototype. Like AD-24's
// one-preload-per-renderer rule, it exposes a single minimal API: hand the
// collected results to main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('protoHost', {
  report: (result) => ipcRenderer.send('proto:result', result),
});
