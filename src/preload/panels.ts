// Panels preload: exposes the panels' minimal API as `window.awp` (AD-24).
// Sandboxed: only electron's renderer API and src/shared, no Node globals.
import { contextBridge } from 'electron';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { SessionKey } from '../shared/detection-events';
import {
  appGetVersion,
  packsChoose,
  packsConfirm,
  packsExport,
  packsRemove,
  poolSetLocked,
  poolSetLockOn,
  poolSetReleased,
  poolSetReleasedMany,
  settingsGet,
  settingsPatch,
} from '../shared/ipc';
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
  pool: Object.freeze({
    setReleased: (sessionKey: SessionKey, released: boolean) =>
      invoke(poolSetReleased, sessionKey, released),
    setReleasedMany: (sessionKeys: readonly SessionKey[], released: boolean) =>
      invoke(poolSetReleasedMany, [...sessionKeys], released),
    setLocked: (sessionKey: SessionKey, locked: boolean) =>
      invoke(poolSetLocked, sessionKey, locked),
    setLockOn: (on: boolean) => invoke(poolSetLockOn, on),
  }),
  packs: Object.freeze({
    choose: () => invoke(packsChoose),
    confirm: (replace: boolean) => invoke(packsConfirm, replace),
    export: (packId: string) => invoke(packsExport, packId),
    remove: (packId: string) => invoke(packsRemove, packId),
  }),
  stageView: Object.freeze({
    subscribe: subscribeStageView,
  }),
});

contextBridge.exposeInMainWorld(PRELOAD_API_KEY, api);
