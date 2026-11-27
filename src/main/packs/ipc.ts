import type {
  PackEntryResult,
  PackManifestResult,
  PackRemoveResult,
} from '../../shared/packs';
import {
  packsChoose,
  packsConfirm,
  packsExport,
  packsGetEntry,
  packsGetManifest,
  packsLog,
  packsRemove,
  packsRuntimeFailed,
} from '../../shared/ipc';
import type {
  PackLogEntry,
  PackRuntimeFailedResult,
  PackRuntimeFailure,
} from '../../shared/sandbox';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import type { PackExporter } from './exporter';
import type { PackImporter } from './importer';

/** Only the panels import, export and remove packs; the overlay gets `sender-rejected`. */
export const PACKS_RENDERERS: ChannelRenderers = ['panels'];

/**
 * Only the overlay, which hosts the packs' sandboxes and draws them, gets
 * their entries and manifests, logs about them and reports their failures
 * (Stories 3.5, 3.6, 3.9); the panels get `sender-rejected`.
 */
export const PACK_SANDBOX_RENDERERS: ChannelRenderers = ['overlay'];

/**
 * The packs' channels:
 * - the import's (Story 3.2), `packs:choose` and `packs:confirm`, and the
 *   export's (Story 3.3), `packs:export`. Each answers null at once and
 *   leaves the rest to the importer or the exporter, so a dialog, a check,
 *   an install or a write never runs into the IPC timeout; the panel sees
 *   how it goes in StageView's `packImport` and `packExport` sections.
 * - `packs:remove` (Story 3.3), which is quick (index.json and one folder):
 *   it answers once `remove` is done, with its result.
 * registerIpcHandler has already checked the arguments against the shared
 * schema, so `packs:confirm` only ever passes a boolean on, and
 * `packs:export` and `packs:remove` a valid pack id.
 */
export function registerPackHandlers(
  importer: Pick<PackImporter, 'choose' | 'confirm'>,
  exporter: Pick<PackExporter, 'start'>,
  remove: (packId: string) => PackRemoveResult,
): void {
  registerIpcHandler(packsChoose, PACKS_RENDERERS, () => {
    void importer.choose();
    return null;
  });
  registerIpcHandler(packsConfirm, PACKS_RENDERERS, (_event, replace) => {
    importer.confirm(replace);
    return null;
  });
  registerIpcHandler(packsExport, PACKS_RENDERERS, (_event, packId) => {
    void exporter.start(packId);
    return null;
  });
  registerIpcHandler(packsRemove, PACKS_RENDERERS, (_event, packId) =>
    remove(packId),
  );
}

/**
 * The sandboxes' channels (Story 3.5 on), overlay only:
 * - `packs:get-entry`: `readEntry` answers with the installed pack's entry
 *   source, or why not (entry.ts);
 * - `packs:log`: `log` writes the line to the run log (sandbox-log.ts);
 * - `packs:get-manifest` (Story 3.6): `readManifest` answers with what the
 *   overlay draws the pack with at a version, or why not
 *   (overlay-manifest.ts);
 * - `packs:runtime-failed` (Story 3.9): `runtimeFailed` counts a sandbox's
 *   failure, marks the version failed from its 4th on (a StageView
 *   change), and answers whether the overlay rebuilds it
 *   (runtime-failures.ts).
 * registerIpcHandler has already checked the arguments against the shared
 * schemas; bad ones reach none of them.
 */
export function registerPackSandboxHandlers(
  readEntry: (packId: string) => Promise<PackEntryResult>,
  log: (entry: PackLogEntry) => void,
  readManifest: (packId: string, version: string) => PackManifestResult,
  runtimeFailed: (failure: PackRuntimeFailure) => PackRuntimeFailedResult,
): void {
  registerIpcHandler(packsGetEntry, PACK_SANDBOX_RENDERERS, (_event, packId) =>
    readEntry(packId),
  );
  registerIpcHandler(packsLog, PACK_SANDBOX_RENDERERS, (_event, entry) => {
    log(entry);
    return null;
  });
  registerIpcHandler(
    packsGetManifest,
    PACK_SANDBOX_RENDERERS,
    (_event, packId, version) => readManifest(packId, version),
  );
  registerIpcHandler(
    packsRuntimeFailed,
    PACK_SANDBOX_RENDERERS,
    (_event, failure) => runtimeFailed(failure),
  );
}
