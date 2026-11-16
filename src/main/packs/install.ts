/**
 * main/packs (Story 3.2): installs a pack from an inspect.ts plan. Whether
 * to replace the installed version is decided before (the user confirms
 * it, Story 3.2's second half); handing the plan here is that decision.
 *
 * 0. The plan must still fit: the pack's installed version (or none) is
 *    the one the plan was made against, else `stale-plan` (another install
 *    came in between, or the plan was already used).
 * 1. Every file is written to a temporary folder in the packs folder
 *    (`.staging-<token>/`), each flushed to disk (fsync) as it is written.
 * 2. That folder becomes `packs/<packId>/<version>/`. For another version
 *    than the installed one, the installed folder stays where it is; for
 *    the same version, it is first moved to
 *    `.backup-<packId>@<version>@<token>/`. A folder already at the target
 *    that index.json does not point to (left behind) is removed first.
 * 3. index.json is written (main/persist: temp file, fsync, rename), and
 *    only then does the store publish the new list through StageView.
 * 4. The old version's folder (or the backup) is removed.
 *
 * A failure in 1 to 3 puts everything back: the new folder is moved aside
 * (a `.staging-…` name) before the backup goes back in place, so the old
 * version is back at its own path before anything is removed and is never
 * left only in the backup; then the moved-aside and temporary folders are
 * removed, and index.json is as it was (its write either happened whole
 * or not at all). The result carries the failure code. A crash or a
 * removal that fails leaves only what the store's start-up cleanup handles:
 * `.staging-…` folders go, and a backup whose version index.json names
 * while its folder is missing goes back in place. A failure in 4 is
 * logged and the install still counts; the cleanup removes the folder at
 * the next start.
 *
 * On a power loss: every file is on disk before index.json (also flushed)
 * can name its version, so index.json never names a version whose files
 * are empty. The renames themselves are not flushed (no folder fsync), so
 * a power loss right after an install may come back with the earlier
 * index.json; the start-up cleanup then removes the new folder.
 *
 * fs is synchronous, as in the store: nothing else runs in main while the
 * folders change. Log lines carry codes, counts and the pack id only.
 */
import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import type { PackInstallFailureCode } from '../../shared/packs';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import type { PackInstallPlan } from './inspect';
import { backupFolderName, STAGING_PREFIX, type PacksStore } from './store';

/** The parts of node:fs an install uses; tests inject failures. */
export interface PackInstallFs {
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  writeFileSync(
    file: string,
    data: Uint8Array,
    options: { readonly flush: true },
  ): void;
  renameSync(from: string, to: string): void;
  rmSync(target: string, options: { recursive: true; force: true }): void;
  existsSync(target: string): boolean;
}

export interface PackInstallOptions {
  readonly fs?: PackInstallFs;
  /** Names the temporary folders; tests make it predictable. */
  readonly token?: () => string;
}

export type PackInstallResult =
  | { readonly ok: true; readonly packId: string; readonly version: string }
  | { readonly ok: false; readonly code: PackInstallFailureCode };

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('packs', message, level);
}

/**
 * Installs `plan` into `store`'s packs folder (see the module comment) and
 * answers how it went. Never throws.
 */
export function installPack(
  store: PacksStore,
  plan: PackInstallPlan,
  { fs = nodeFs, token = randomUUID }: PackInstallOptions = {},
): PackInstallResult {
  const { packId } = plan;
  function fail(
    code: PackInstallFailureCode,
    cause?: unknown,
  ): PackInstallResult {
    const why = cause === undefined ? '' : ` (${errorCode(cause)})`;
    log(`could not install pack ${packId}: ${code}${why}`, 'error');
    return { ok: false, code };
  }
  /** Removes `target`; a failure only adds its code to `problems`. */
  function removeQuietly(target: string, problems: string[]): void {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      problems.push(errorCode(error));
    }
  }

  if (!store.canWrite) {
    return fail('index-unwritable');
  }
  const installedVersion = store.find(packId)?.version ?? null;
  if (installedVersion !== (plan.previous?.version ?? null)) {
    return fail('stale-plan');
  }

  const id = token();
  const staging = path.join(store.dir, `${STAGING_PREFIX}${id}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const [at, data] of plan.files) {
      const target = path.join(staging, ...at.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { flush: true });
    }
  } catch (error) {
    const problems: string[] = [];
    removeQuietly(staging, problems);
    if (problems.length > 0) {
      log(
        `could not remove pack ${packId}'s temporary folder (${problems.join(', ')}); the next start removes it`,
        'error',
      );
    }
    return fail('extract-failed', error);
  }

  const previous = store.find(packId);
  const packDir = path.join(store.dir, packId);
  const target = path.join(packDir, plan.version);
  const sameVersion = previous?.version === plan.version;
  let backup: string | undefined;
  let placed = false;

  /**
   * Puts back what step 2 changed: the new folder moved aside first, the
   * backup back in place, and only then the removals. Logs anything that
   * would not go back.
   */
  function rollBack(): void {
    const problems: string[] = [];
    const discard = path.join(store.dir, `${STAGING_PREFIX}${id}-discard`);
    if (placed) {
      try {
        fs.renameSync(target, discard);
      } catch (error) {
        problems.push(errorCode(error));
        removeQuietly(target, problems);
      }
    }
    if (backup !== undefined) {
      try {
        fs.renameSync(backup, target);
      } catch (error) {
        problems.push(errorCode(error));
      }
    }
    if (placed) {
      removeQuietly(discard, problems);
    }
    removeQuietly(staging, problems);
    if (problems.length > 0) {
      log(
        `could not put pack ${packId} back as it was (${problems.join(', ')})`,
        'error',
      );
    }
  }

  try {
    fs.mkdirSync(packDir, { recursive: true });
    if (fs.existsSync(target)) {
      if (sameVersion) {
        backup = path.join(
          store.dir,
          backupFolderName(packId, plan.version, id),
        );
        fs.renameSync(target, backup);
      } else {
        // Left behind: index.json does not point to it.
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    fs.renameSync(staging, target);
    placed = true;
  } catch (error) {
    rollBack();
    return fail('replace-failed', error);
  }

  try {
    store.save([
      ...store.list().filter((entry) => entry.id !== packId),
      plan.index,
    ]);
  } catch (error) {
    rollBack();
    return fail('index-write-failed', error);
  }

  const problems: string[] = [];
  if (backup !== undefined) {
    removeQuietly(backup, problems);
  }
  if (previous !== undefined && !sameVersion) {
    removeQuietly(path.join(packDir, previous.version), problems);
  }
  if (problems.length > 0) {
    log(
      `pack ${packId}: could not remove the replaced folder (${problems.join(', ')}); the next start removes it`,
      'warn',
    );
  }
  log(
    `installed pack ${packId} (${plan.files.size} files${previous === undefined ? '' : ', replacing the installed version'})`,
  );
  return { ok: true, packId, version: plan.version };
}
