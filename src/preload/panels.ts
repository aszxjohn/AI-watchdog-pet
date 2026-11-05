// Panels preload: exposes the panels' minimal API as `window.awp` (AD-24).
// Sandboxed: only electron's renderer API and src/shared, no Node globals.
import { contextBridge } from 'electron';
import { PRELOAD_API_KEY } from '../shared/constants';
import { appGetVersion } from '../shared/ipc';
import type { PanelsApi } from '../shared/preload-api';
import { invoke } from './invoke';

const api: PanelsApi = Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke(appGetVersion),
  }),
});

contextBridge.exposeInMainWorld(PRELOAD_API_KEY, api);
