/**
 * main/packs (Story 3.5): hands an installed pack's entry source to the
 * overlay, for that pack's sandbox (`packs:get-entry`). Which file is the
 * entry comes from the installed version's own `manifest.json` (its
 * `entry`, which must be a pack path and one of the pack's `servedPaths`);
 * install keeps `servedPaths` sorted, so their order says nothing. The
 * file is read from the installed version's folder.
 *
 * Right before reading, the pack's `apiVersion` is checked again
 * (checkApiCompatibility): an incompatible pack's entry is never handed
 * over, so it never runs. Log lines carry the pack id, version and a code,
 * never a path or the source.
 */
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { checkApiCompatibility, packPathSchema } from '../../shared/pack-api';
import type { PackEntryResult } from '../../shared/packs';
import { errorCode, logEvent } from '../log/run-log';
import type { PacksStore } from './store';

/** The parts of node:fs/promises reading an entry uses; tests may inject them. */
export interface PackEntryFs {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
}

/**
 * The entry source of the installed pack `packId`, or why not:
 * `not-installed`, `api-incompatible` or `read-failed`. Never rejects.
 */
export async function readPackEntry(
  store: Pick<PacksStore, 'dir' | 'find'>,
  packId: string,
  fs: PackEntryFs = nodeFs,
): Promise<PackEntryResult> {
  const installed = store.find(packId);
  if (installed === undefined) {
    logEvent('packs', `pack ${packId}: entry not handed over (not-installed)`);
    return { ok: false, code: 'not-installed' };
  }
  const compatibility = checkApiCompatibility(installed.apiVersion);
  if (!compatibility.compatible) {
    logEvent(
      'packs',
      `pack ${packId}: entry not handed over (api-incompatible: ${compatibility.reason}, needs API ${compatibility.required})`,
      'warn',
    );
    return { ok: false, code: 'api-incompatible' };
  }
  const folder = path.join(store.dir, installed.id, installed.version);
  const readFailed = (why: string): PackEntryResult => {
    logEvent(
      'packs',
      `pack ${packId}: entry not handed over (read-failed: ${why})`,
      'error',
    );
    return { ok: false, code: 'read-failed' };
  };
  let entry: unknown;
  try {
    const text = await fs.readFile(path.join(folder, 'manifest.json'), 'utf8');
    // Install took the manifest with a UTF-8 BOM too.
    const manifest: unknown = JSON.parse(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    );
    entry =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as { entry?: unknown }).entry
        : undefined;
  } catch (error) {
    return readFailed(`manifest ${errorCode(error)}`);
  }
  const parsed = packPathSchema.safeParse(entry);
  if (!parsed.success || !installed.servedPaths.includes(parsed.data)) {
    return readFailed('manifest entry is not a served path');
  }
  let source: string;
  try {
    source = await fs.readFile(
      path.join(folder, ...parsed.data.split('/')),
      'utf8',
    );
  } catch (error) {
    return readFailed(errorCode(error));
  }
  logEvent(
    'packs',
    `pack ${packId}: entry handed to its sandbox (version ${installed.version})`,
  );
  return {
    ok: true,
    packId: installed.id,
    version: installed.version,
    source,
  };
}
