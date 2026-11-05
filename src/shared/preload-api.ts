import type { PRELOAD_API_KEY } from './constants';
import type { IpcData, IpcResult, appGetVersion } from './ipc';

/** `window.awp` in the panels renderer (src/preload/panels.ts). */
export interface PanelsApi {
  readonly app: {
    getVersion(): Promise<IpcResult<IpcData<typeof appGetVersion>>>;
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
