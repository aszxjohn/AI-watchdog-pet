/**
 * main/packs (Story 3.3's second half): removes an installed pack, once the
 * panel has had the user confirm it.
 *
 * 1. The pack must be installed (`not-installed` otherwise) and index.json
 *    writable this run (`index-unwritable` otherwise).
 * 2. index.json is written without it (the store: temp file, fsync,
 *    rename), and only then does the store publish the shorter list through
 *    StageView. A write that fails is `index-write-failed`: nothing was
 *    removed, the files are all there.
 * 3. Its folder `packs/<packId>/` (every version in it) goes. A failure
 *    there is only logged; the pack still counts as removed, and the
 *    store's start-up cleanup removes the folder of a pack id index.json
 *    does not list at the next start. Only that one folder right under the
 *    packs folder is touched, and only for a valid pack id.
 *
 * settings.json is not touched: the pack's 上場 and its characters'
 * 加入池子 values stay, as for any pack not installed, and come back when
 * the same pack is imported again. A pack waiting to replace this one (the
 * importer's confirmation) then installs as `stale-plan`, since the version
 * it was checked against is gone. An export already reading it is not held
 * up: it has its files in memory, or finds the pack gone (`not-installed`).
 *
 * fs is synchronous, as in the store and install.ts. Never throws. Log lines
 * carry codes and the pack id only.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { packIdSchema } from '../../shared/pack-api';
import type {
  PackRemoveFailureCode,
  PackRemoveResult,
} from '../../shared/packs';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import type { PacksStore } from './store';

/** The part of node:fs a removal uses; tests inject failures. */
export interface PackRemoveFs {
  rmSync(target: string, options: { recursive: true; force: true }): void;
}

export interface PackRemoveOptions {
  readonly fs?: PackRemoveFs;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('packs', message, level);
}

/**
 * Removes the installed pack `packId` from `store` (see the module comment)
 * and answers whether it went. Never throws.
 */
export function removePack(
  store: Pick<PacksStore, 'dir' | 'canWrite' | 'find' | 'list' | 'save'>,
  packId: string,
  { fs = nodeFs }: PackRemoveOptions = {},
): PackRemoveResult {
  function fail(code: PackRemoveFailureCode, cause?: unknown) {
    const why = cause === undefined ? '' : ` (${errorCode(cause)})`;
    log(
      `could not remove pack ${packId}: ${code}${why}`,
      code === 'not-installed' ? 'warn' : 'error',
    );
    return { ok: false, code } as const;
  }

  // An id that is not valid is never installed (index.json holds valid ids
  // only), and never names a folder to remove.
  if (
    !packIdSchema.safeParse(packId).success ||
    store.find(packId) === undefined
  ) {
    return fail('not-installed');
  }
  if (!store.canWrite) {
    return fail('index-unwritable');
  }
  try {
    store.save(store.list().filter((entry) => entry.id !== packId));
  } catch (error) {
    return fail('index-write-failed', error);
  }

  try {
    fs.rmSync(path.join(store.dir, packId), { recursive: true, force: true });
  } catch (error) {
    log(
      `pack ${packId}: removed from the list, but its folder could not be removed (${errorCode(error)}); the next start removes it`,
      'error',
    );
    return { ok: true };
  }
  log(`removed pack ${packId}`);
  return { ok: true };
}
