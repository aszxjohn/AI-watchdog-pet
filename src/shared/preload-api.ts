import type { PRELOAD_API_KEY } from './constants';
import type { SessionKey } from './detection-events';
import type {
  CanvasGpuState,
  CanvasHover,
  CanvasReadyReport,
  IpcData,
  IpcError,
  IpcResult,
  appGetVersion,
  canvasContextMenu,
  canvasGpu,
  canvasReady,
  canvasSetHover,
  packsChoose,
  packsConfirm,
  packsExport,
  packsGetEntry,
  packsGetManifest,
  packsLog,
  packsRemove,
  packsRuntimeFailed,
  poolSetReleased,
  settingsGet,
  settingsPatch,
} from './ipc';
import type { PackLogEntry, PackRuntimeFailure } from './sandbox';
import type { SettingsPatch } from './settings';
import type { StageViewSnapshot } from './stage-view';

/** StageView as both renderers see it (src/preload/stage-view.ts). */
export interface StageViewApi {
  /**
   * Calls `listener` with the StageView snapshot, then after each change.
   * `onError` hears about a snapshot that could not be fetched. Returns an
   * unsubscribe function.
   */
  subscribe(
    listener: (snapshot: StageViewSnapshot) => void,
    onError?: (error: IpcError) => void,
  ): () => void;
}

/** `window.awp` in the panels renderer (src/preload/panels.ts). */
export interface PanelsApi {
  readonly app: {
    getVersion(): Promise<IpcResult<IpcData<typeof appGetVersion>>>;
  };
  readonly settings: {
    /** The current values and their rev. */
    get(): Promise<IpcResult<IpcData<typeof settingsGet>>>;
    /**
     * Applies field operations (AD-23). The result comes back through
     * StageView; do not update local state from the reply.
     */
    patch(
      patch: SettingsPatch,
    ): Promise<IpcResult<IpcData<typeof settingsPatch>>>;
  };
  readonly pool: {
    /**
     * Releases the session at `sessionKey` (true) or shows it again
     * (false) (Story 2.8). The result comes back through StageView's
     * `pool` section; do not update local state from the reply.
     */
    setReleased(
      sessionKey: SessionKey,
      released: boolean,
    ): Promise<IpcResult<IpcData<typeof poolSetReleased>>>;
  };
  readonly packs: {
    /**
     * Asks main to open the file dialog and import the `.awpet` picked
     * (Story 3.2). Answers at once; the import's progress and outcome
     * come back through StageView's `packImport` section.
     */
    choose(): Promise<IpcResult<IpcData<typeof packsChoose>>>;
    /**
     * Replaces the installed version with the pack waiting for
     * confirmation (true), or leaves it (false). The outcome comes back
     * through StageView; do not update local state from the reply.
     */
    confirm(replace: boolean): Promise<IpcResult<IpcData<typeof packsConfirm>>>;
    /**
     * Asks main to open the save dialog and export the installed pack
     * `packId` (Story 3.3). Answers at once; the export's progress and
     * outcome come back through StageView's `packExport` section.
     */
    export(packId: string): Promise<IpcResult<IpcData<typeof packsExport>>>;
    /**
     * Removes the installed pack `packId` (the page has had the user
     * confirm it). Answers once done: removed, or why nothing changed;
     * the list comes back through StageView's `packs` section.
     */
    remove(packId: string): Promise<IpcResult<IpcData<typeof packsRemove>>>;
  };
  readonly stageView: StageViewApi;
}

/** `window.awp` in the overlay renderer (src/preload/overlay.ts). */
export interface OverlayApi {
  readonly stageView: StageViewApi;
  readonly canvas: {
    /**
     * Reports, once per page load, whether the canvas initialised (for the
     * run log).
     */
    ready(
      report: CanvasReadyReport,
    ): Promise<IpcResult<IpcData<typeof canvasReady>>>;
    /**
     * Says the cursor moved onto (`over: true`) or off what takes the mouse
     * (AD-14); main turns click-through off or back on. Send one only when
     * that changes, `seq` one more each time.
     */
    setHover(
      hover: CanvasHover,
    ): Promise<IpcResult<IpcData<typeof canvasSetHover>>>;
    /**
     * Says the session at `sessionKey` was right-clicked; main pops up its
     * menu on the canvas.
     */
    contextMenu(
      sessionKey: SessionKey,
    ): Promise<IpcResult<IpcData<typeof canvasContextMenu>>>;
    /**
     * Says the canvas's WebGL context was lost or is back (Story 3.6), only
     * when that changes; main reloads the page when it is not back in time.
     */
    gpu(state: CanvasGpuState): Promise<IpcResult<IpcData<typeof canvasGpu>>>;
  };
  readonly packs: {
    /**
     * The installed pack's entry source, for its sandbox (Story 3.5), or
     * why main does not hand it over.
     */
    getEntry(packId: string): Promise<IpcResult<IpcData<typeof packsGetEntry>>>;
    /**
     * What the overlay draws the installed pack with at `version` (Story
     * 3.6): its manifest and spritesheets, checked, or why not.
     */
    getManifest(
      packId: string,
      version: string,
    ): Promise<IpcResult<IpcData<typeof packsGetManifest>>>;
    /** Writes one line about a pack's sandbox to the run log. */
    log(entry: PackLogEntry): Promise<IpcResult<IpcData<typeof packsLog>>>;
    /**
     * Says a pack's sandbox failed (Story 3.9); main answers whether the
     * overlay builds the pack a new one.
     */
    runtimeFailed(
      failure: PackRuntimeFailure,
    ): Promise<IpcResult<IpcData<typeof packsRuntimeFailed>>>;
  };
}

/**
 * A renderer's `window` as its preload leaves it. The key is optional because
 * the preload may have failed to load; renderers must check for it.
 */
export type PreloadHost<Api> = {
  readonly [K in typeof PRELOAD_API_KEY]?: Api;
};
