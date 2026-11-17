/**
 * main/packs (Story 3.6): what the overlay draws an installed pack with
 * (`packs:get-manifest`), at the version it asks for: that version's own
 * `manifest.json`, checked by readInstalledManifest, and the JSON of each
 * of its spritesheet assets, checked against the pack API's
 * spritesheetSchema (which keeps only the fields the stage reads). The
 * images themselves the overlay loads from `pack://`, so this hands over no
 * file content but those JSON files, and never a path on disk.
 *
 * Right before reading, the pack must be installed at exactly that version
 * and fit this stage's API (checkApiCompatibility), as for its entry. A
 * sheet's image (`meta.image` taken relative to the sheet) must be one of
 * the pack's `servedPaths`, so the overlay never asks `pack://` for a file
 * it does not serve. Any problem gives one log line with the pack id,
 * version and a code, and the pack's failure code; nothing is cached, since
 * a pack may be installed again over the same version.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  checkApiCompatibility,
  spritesheetImagePath,
  spritesheetSchema,
} from '../../shared/pack-api';
import type {
  PackManifestResult,
  PackSpritesheetEntry,
} from '../../shared/packs';
import { errorCode, logEvent } from '../log/run-log';
import { readInstalledManifest, type InstalledManifestFs } from './manifest';
import type { PacksStore } from './store';

/**
 * What the overlay draws version `version` of the installed pack `packId`
 * with, or why not: `not-installed`, `api-incompatible` or `read-failed`.
 * Never throws.
 */
export function readPackManifest(
  store: Pick<PacksStore, 'dir' | 'find'>,
  packId: string,
  version: string,
  fs: InstalledManifestFs = nodeFs,
): PackManifestResult {
  const at = `pack ${packId} ${version}`;
  const installed = store.find(packId);
  if (installed === undefined || installed.version !== version) {
    logEvent(
      'packs',
      `${at}: manifest not handed to the overlay (not-installed)`,
    );
    return { ok: false, code: 'not-installed' };
  }
  const compatibility = checkApiCompatibility(installed.apiVersion);
  if (!compatibility.compatible) {
    logEvent(
      'packs',
      `${at}: manifest not handed to the overlay (api-incompatible: ${compatibility.reason}, needs API ${compatibility.required})`,
      'warn',
    );
    return { ok: false, code: 'api-incompatible' };
  }
  const readFailed = (why: string): PackManifestResult => {
    logEvent(
      'packs',
      `${at}: manifest not handed to the overlay (read-failed: ${why})`,
      'error',
    );
    return { ok: false, code: 'read-failed' };
  };
  const read = readInstalledManifest(store.dir, packId, version, fs);
  if (!read.ok) {
    return readFailed(
      `manifest ${read.code}${read.detail === undefined ? '' : ` ${read.detail}`}`,
    );
  }
  const { manifest } = read;
  const folder = path.join(store.dir, installed.id, installed.version);
  const spritesheets: Record<string, PackSpritesheetEntry> = {};
  for (const [key, asset] of Object.entries(manifest.assets)) {
    if (asset.kind !== 'spritesheet') {
      continue;
    }
    let json: unknown;
    try {
      const text = fs.readFileSync(
        path.join(folder, ...asset.path.split('/')),
        'utf8',
      );
      // Install took the JSON with a UTF-8 BOM too.
      json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      return readFailed(
        `spritesheet ${key} ${error instanceof SyntaxError ? 'not-json' : errorCode(error)}`,
      );
    }
    const parsed = spritesheetSchema.safeParse(json);
    if (!parsed.success) {
      return readFailed(`spritesheet ${key} invalid`);
    }
    const image = spritesheetImagePath(asset.path, parsed.data.meta.image);
    if (!installed.servedPaths.includes(image)) {
      return readFailed(`spritesheet ${key} image is not a served path`);
    }
    spritesheets[key] = { image, data: parsed.data };
  }
  return {
    ok: true,
    packId: installed.id,
    version: installed.version,
    manifest,
    spritesheets,
  };
}
