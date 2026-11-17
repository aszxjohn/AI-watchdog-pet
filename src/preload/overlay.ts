// Overlay preload: exposes the overlay's minimal API as `window.awp` (AD-24):
// the StageView subscription, the `canvas:ready` report, the canvas's
// hover and right-click requests, and the packs' sandboxes' entry sources
// and run log lines (Story 3.5). Sandboxed: only electron's renderer API
// and src/shared, no Node globals.
import { contextBridge } from 'electron';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { SessionKey } from '../shared/detection-events';
import {
  canvasContextMenu,
  canvasReady,
  canvasSetHover,
  packsGetEntry,
  packsLog,
  type CanvasHover,
  type CanvasReadyReport,
} from '../shared/ipc';
import type { OverlayApi } from '../shared/preload-api';
import type { PackLogEntry } from '../shared/sandbox';
import { invoke } from './invoke';
import { subscribeStageView } from './stage-view';

const api: OverlayApi = Object.freeze({
  stageView: Object.freeze({
    subscribe: subscribeStageView,
  }),
  canvas: Object.freeze({
    ready: (report: CanvasReadyReport) => invoke(canvasReady, report),
    setHover: (hover: CanvasHover) => invoke(canvasSetHover, hover),
    contextMenu: (sessionKey: SessionKey) =>
      invoke(canvasContextMenu, { sessionKey }),
  }),
  packs: Object.freeze({
    getEntry: (packId: string) => invoke(packsGetEntry, packId),
    log: (entry: PackLogEntry) => invoke(packsLog, entry),
  }),
});

contextBridge.exposeInMainWorld(PRELOAD_API_KEY, api);
