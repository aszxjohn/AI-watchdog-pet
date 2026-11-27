/**
 * main/packs (Story 3.9): the packs' sandbox failures the overlay reports
 * (`packs:runtime-failed`), counted by pack and version in main/packs'
 * store, and whether the overlay builds the pack a new sandbox.
 *
 * - A failure of the version installed now counts one more for that
 *   pack@version. The first PACK_RESTART_LIMIT are answered with a
 *   rebuild; from the next one on, with none (the overlay leaves the
 *   sandbox stopped and its actors in the placeholder).
 * - The first failure answered with none also marks that version failed
 *   in the store (its StagePack's `runtimeFailed`, with that failure's
 *   reason): main/pool takes the pack out of the pool and swaps its
 *   actors, demo mode still shows it, and the 角色包 page says why. main.ts
 *   runs each report in one StageView batch, so the mark and the actors it
 *   swaps are one delta.
 * - A failure of a version that is not the one installed now (the pack
 *   was updated or removed while the overlay was asking) is neither
 *   rebuilt nor counted.
 * - The counts and the mark are the store's, in memory only: nothing is
 *   written (not to index.json either), and the next run starts from 0.
 *   Importing the pack again (any version, the same one included) or
 *   removing it clears them.
 *
 * Every answer writes one run log line (category `packs`) with the pack
 * id, the version, the reason and the count; the reason has passed the
 * shared schema already (an English code).
 */
import { PACK_RESTART_LIMIT } from '../../shared/constants';
import type {
  PackRuntimeFailedResult,
  PackRuntimeFailure,
} from '../../shared/sandbox';
import { logEvent } from '../log/run-log';
import type { PacksStore } from './store';

export interface RuntimeFailures {
  /** Counts `failure` and answers whether the overlay rebuilds the sandbox. */
  report(failure: PackRuntimeFailure): PackRuntimeFailedResult;
}

/** The failures of the packs installed in `store` (see the module comment). */
export function createRuntimeFailures(
  store: Pick<PacksStore, 'find' | 'countFailure' | 'markFailed'>,
): RuntimeFailures {
  return {
    report({ packId, version, reason }) {
      const pack = `pack ${packId}`;
      const count = store.countFailure(packId, version);
      if (count === undefined) {
        const installed = store.find(packId)?.version;
        logEvent(
          'packs',
          `${pack}: not restarting its sandbox of version ${version} (${reason}): ${installed === undefined ? 'the pack is not installed' : `version ${installed} is installed`}; not counted`,
        );
        return { restart: false };
      }
      if (count <= PACK_RESTART_LIMIT) {
        logEvent(
          'packs',
          `${pack}: restarting its sandbox of version ${version} (${reason}; restart ${count} of ${PACK_RESTART_LIMIT})`,
          'warn',
        );
        return { restart: true };
      }
      const marked = store.markFailed(packId, version, reason);
      logEvent(
        'packs',
        `${pack}: not restarting its sandbox of version ${version} (${reason}; failure ${count}, past ${PACK_RESTART_LIMIT} restarts in this run): ${marked ? 'marked it failed' : 'marked failed already'}; out of the pool until the pack is imported again or the app restarts`,
        'error',
      );
      return { restart: false };
    },
  };
}
