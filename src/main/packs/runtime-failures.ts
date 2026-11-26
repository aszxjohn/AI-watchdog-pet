/**
 * main/packs (Story 3.9): the packs' sandbox failures the overlay reports
 * (`packs:runtime-failed`), counted by pack and version, and whether the
 * overlay builds the pack a new sandbox.
 *
 * - A failure of the version installed now counts one more for that
 *   pack@version. The first PACK_RESTART_LIMIT are answered with a
 *   rebuild; from the next one on, with none (the overlay leaves the
 *   sandbox failed and its actors in the placeholder; the pack boots
 *   again only once it has had no actor for SANDBOX_IDLE_MS and one comes
 *   back).
 * - A failure of a version that is not the one installed now (the pack
 *   was updated or removed while the overlay was asking) is neither
 *   rebuilt nor counted.
 * - Another version counts from 0. The counts are kept in memory only:
 *   nothing is written (not to index.json either), and the next run
 *   starts from 0.
 *
 * Every answer writes one run log line (category `packs`) with the pack
 * id, the version, the reason and the count; the reason has passed the
 * shared schema already (an English code).
 */
import { PACK_RESTART_LIMIT, SANDBOX_IDLE_MS } from '../../shared/constants';
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
  store: Pick<PacksStore, 'find'>,
): RuntimeFailures {
  /** The failures counted, by `<packId>@<version>`. */
  const counts = new Map<string, number>();

  return {
    report({ packId, version, reason }) {
      const pack = `pack ${packId}`;
      const installed = store.find(packId)?.version;
      if (installed !== version) {
        logEvent(
          'packs',
          `${pack}: not restarting its sandbox of version ${version} (${reason}): ${installed === undefined ? 'the pack is not installed' : `version ${installed} is installed`}; not counted`,
        );
        return { restart: false };
      }
      // Neither a pack id nor a version has an `@`.
      const key = `${packId}@${version}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= PACK_RESTART_LIMIT) {
        logEvent(
          'packs',
          `${pack}: restarting its sandbox of version ${version} (${reason}; restart ${count} of ${PACK_RESTART_LIMIT})`,
          'warn',
        );
        return { restart: true };
      }
      logEvent(
        'packs',
        `${pack}: not restarting its sandbox of version ${version} (${reason}; failure ${count}, past ${PACK_RESTART_LIMIT} restarts in this run): not rebuilt now, its actors stay in the placeholder; it boots again only once it has had no actor for ${SANDBOX_IDLE_MS} ms and one comes back`,
        'error',
      );
      return { restart: false };
    },
  };
}
