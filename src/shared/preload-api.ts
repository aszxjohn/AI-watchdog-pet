import type { PRELOAD_API_KEY } from './constants';
import type {
  IpcData,
  IpcError,
  IpcResult,
  appGetVersion,
  settingsGet,
  settingsPatch,
} from './ipc';
import type { SettingsPatch } from './settings';
import type { StageViewSnapshot } from './stage-view';

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
  readonly stageView: {
    /**
     * Calls `listener` with the StageView snapshot, then after each change.
     * `onError` hears about a snapshot that could not be fetched. Returns an
     * unsubscribe function.
     */
    subscribe(
      listener: (snapshot: StageViewSnapshot) => void,
      onError?: (error: IpcError) => void,
    ): () => void;
  };
}

/** `window.awp` in the overlay renderer (src/preload/overlay.ts); empty for now. */
export type OverlayApi = Readonly<Record<string, never>>;

/**
 * A renderer's `window` as its preload leaves it. The key is optional because
 * the preload may have failed to load; renderers must check for it.
 */
export type PreloadHost<Api> = {
  readonly [K in typeof PRELOAD_API_KEY]?: Api;
};
