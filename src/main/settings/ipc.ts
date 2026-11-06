import { settingsGet, settingsPatch } from '../../shared/ipc';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import type { SettingsStore } from './store';

/** Only the panels read or change settings; the overlay gets `sender-rejected`. */
export const SETTINGS_RENDERERS: ChannelRenderers = ['panels'];

/**
 * The only settings channels (AD-23): `settings:get` and `settings:patch`.
 * registerIpcHandler has already validated the patch against the shared
 * schema, so an invalid one never reaches the store.
 */
export function registerSettingsHandlers(
  store: Pick<SettingsStore, 'get' | 'patch'>,
): void {
  registerIpcHandler(settingsGet, SETTINGS_RENDERERS, () => store.get());
  registerIpcHandler(settingsPatch, SETTINGS_RENDERERS, (_event, patch) =>
    store.patch(patch),
  );
}
