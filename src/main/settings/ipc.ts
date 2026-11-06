import { settingsGet, settingsPatch } from '../../shared/ipc';
import { registerIpcHandler } from '../ipc/register';
import type { SettingsStore } from './store';

/**
 * The only settings channels (AD-23): `settings:get` and `settings:patch`.
 * registerIpcHandler has already validated the patch against the shared
 * schema, so an invalid one never reaches the store.
 */
export function registerSettingsHandlers(
  store: Pick<SettingsStore, 'get' | 'patch'>,
): void {
  registerIpcHandler(settingsGet, () => store.get());
  registerIpcHandler(settingsPatch, (_event, patch) => store.patch(patch));
}
