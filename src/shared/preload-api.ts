import type { PRELOAD_API_KEY } from './constants';
import type { SessionKey } from './detection-events';
import type {
  CanvasHover,
  CanvasReadyReport,
  IpcData,
  IpcError,
  IpcResult,
  appGetVersion,
  canvasContextMenu,
  canvasReady,
  canvasSetHover,
  poolSetReleased,
  settingsGet,
  settingsPatch,
} from './ipc';
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
  };
}

/**
 * A renderer's `window` as its preload leaves it. The key is optional because
 * the preload may have failed to load; renderers must check for it.
 */
export type PreloadHost<Api> = {
  readonly [K in typeof PRELOAD_API_KEY]?: Api;
};
