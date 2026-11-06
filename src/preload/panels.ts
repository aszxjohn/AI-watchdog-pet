// Panels preload: exposes the panels' minimal API as `window.awp` (AD-24).
// Sandboxed: only electron's renderer API and src/shared, no Node globals.
import { contextBridge } from 'electron';
import { PRELOAD_API_KEY } from '../shared/constants';
import { appGetVersion, settingsGet, settingsPatch } from '../shared/ipc';
import type { PanelsApi } from '../shared/preload-api';
import type { SettingsPatch } from '../shared/settings';
import { invoke } from './invoke';
import { subscribeStageView } from './stage-view';

const api: PanelsApi = Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke(appGetVersion),
  }),
  settings: Object.freeze({
    get: () => invoke(settingsGet),
    patch: (patch: SettingsPatch) => invoke(settingsPatch, patch),
  }),
  stageView: Object.freeze({
    subscribe: subscribeStageView,
  }),
});

contextBridge.exposeInMainWorld(PRELOAD_API_KEY, api);
