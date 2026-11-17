import { settingsGet, settingsPatch } from '../../shared/ipc';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import type { SettingsStore } from './store';

/** Only the panels read or change settings; the overlay gets `sender-rejected`. */
export const SETTINGS_RENDERERS: ChannelRenderers = ['panels'];

/**
 * Runs a change as one StageView delta (main/stage-view's batch(); main.ts
 * hands the hub itself). Synchronous: answers what `run` returns, and
 * throws what it throws.
 */
export interface SettingsPatchBatch {
  batch<T>(run: () => T): T;
}

/**
 * The only settings channels (AD-23): `settings:get` and `settings:patch`.
 * registerIpcHandler has already validated the patch against the shared
 * schema, so an invalid one never reaches the store. A patch runs in one
 * StageView batch (Story 3.6, Epic 1 retro R10): everything it changes at
 * once (settings, and through their listeners canvas, sessions, actors,
 * characters) reaches the renderers as one delta.
 */
export function registerSettingsHandlers(
  store: Pick<SettingsStore, 'get' | 'patch'>,
  stageView: SettingsPatchBatch,
): void {
  registerIpcHandler(settingsGet, SETTINGS_RENDERERS, () => store.get());
  registerIpcHandler(settingsPatch, SETTINGS_RENDERERS, (_event, patch) =>
    stageView.batch(() => store.patch(patch)),
  );
}
