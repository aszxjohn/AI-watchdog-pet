// Overlay preload: exposes the overlay's minimal API as `window.awp` (AD-24):
// the StageView subscription, the `canvas:ready` report, the canvas's
// hover and right-click requests, what became of its WebGL context
// (Story 3.6), the packs' sandboxes' entry sources and run log lines
// (Story 3.5), what the overlay draws each pack with (Story 3.6), and a
// failed sandbox, which main answers with whether to rebuild it (Story 3.9).
// Sandboxed: only electron's renderer API and src/shared, no Node globals.
import { contextBridge } from 'electron';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { SessionKey } from '../shared/detection-events';
import {
  canvasContextMenu,
  canvasGpu,
  canvasReady,
  canvasSetHover,
  packsGetEntry,
  packsGetManifest,
  packsLog,
  packsRuntimeFailed,
  type CanvasGpuState,
  type CanvasHover,
  type CanvasReadyReport,
} from '../shared/ipc';
import type { OverlayApi } from '../shared/preload-api';
import type { PackLogEntry, PackRuntimeFailure } from '../shared/sandbox';
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
    gpu: (state: CanvasGpuState) => invoke(canvasGpu, state),
  }),
  packs: Object.freeze({
    getEntry: (packId: string) => invoke(packsGetEntry, packId),
    getManifest: (packId: string, version: string) =>
      invoke(packsGetManifest, packId, version),
    log: (entry: PackLogEntry) => invoke(packsLog, entry),
    runtimeFailed: (failure: PackRuntimeFailure) =>
      invoke(packsRuntimeFailed, failure),
  }),
});

contextBridge.exposeInMainWorld(PRELOAD_API_KEY, api);
