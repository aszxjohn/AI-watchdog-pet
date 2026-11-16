import { packsChoose, packsConfirm } from '../../shared/ipc';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import type { PackImporter } from './importer';

/** Only the panels import packs; the overlay gets `sender-rejected`. */
export const PACKS_RENDERERS: ChannelRenderers = ['panels'];

/**
 * The import's channels (Story 3.2): `packs:choose` and `packs:confirm`.
 * Both answer null at once and leave the rest to the importer, so the file
 * dialog, the check and the install never run into the IPC timeout; the
 * panel sees how it goes in StageView's `packImport` section.
 * registerIpcHandler has already checked the arguments against the shared
 * schema, so `packs:confirm` only ever passes a boolean on.
 */
export function registerPackHandlers(
  importer: Pick<PackImporter, 'choose' | 'confirm'>,
): void {
  registerIpcHandler(packsChoose, PACKS_RENDERERS, () => {
    void importer.choose();
    return null;
  });
  registerIpcHandler(packsConfirm, PACKS_RENDERERS, (_event, replace) => {
    importer.confirm(replace);
    return null;
  });
}
