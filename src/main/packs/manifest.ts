/**
 * main/packs (Story 3.6): reads an installed version's own `manifest.json`
 * (`<packs dir>/<packId>/<version>/manifest.json`) and checks it against
 * manifestSchema, for main/settings to work out each character's effective
 * parameters (main.ts hands it this as a function; main/settings does not
 * import main/packs).
 *
 * The file is read every time: a pack can be installed again over the same
 * version, so `<packId>@<version>` says nothing about what the file holds.
 * A UTF-8 BOM is allowed, as install took it. A manifest whose `id` or
 * `version` is not the folder's counts as not this pack's (`mismatch`).
 *
 * Synchronous, as the packs store is: a manifest is small, and main/settings
 * works the characters out within the change that asks for them. Never
 * throws and logs nothing; the caller logs the code with the pack id. The
 * failure codes are src/shared/packs' INSTALLED_MANIFEST_FAILURES.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { manifestSchema } from '../../shared/pack-api';
import type { InstalledManifestResult } from '../../shared/packs';
import { errorCode } from '../log/run-log';
import { MANIFEST_FILE } from './inspect';

/** The part of node:fs reading a manifest uses; tests may inject it. */
export interface InstalledManifestFs {
  readFileSync(file: string, encoding: 'utf8'): string;
}

/** The manifest of version `version` of pack `packId`, installed in `dir`. */
export function readInstalledManifest(
  dir: string,
  packId: string,
  version: string,
  fs: InstalledManifestFs = nodeFs,
): InstalledManifestResult {
  let text: string;
  try {
    text = fs.readFileSync(
      path.join(dir, packId, version, MANIFEST_FILE),
      'utf8',
    );
  } catch (error) {
    return { ok: false, code: 'unreadable', detail: errorCode(error) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // The SyntaxError message quotes the file, so it is not kept.
    return { ok: false, code: 'not-json' };
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-manifest' };
  }
  if (parsed.data.id !== packId || parsed.data.version !== version) {
    return { ok: false, code: 'mismatch' };
  }
  return { ok: true, manifest: parsed.data };
}
