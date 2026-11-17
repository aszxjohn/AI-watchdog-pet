/**
 * overlay/looks (Story 3.6): what the overlay draws each pack with, at the
 * version installed: its manifest (characters' `states`, `fallback`,
 * `hitbox`, `bounds`; its `assets`) and its spritesheets' JSON, which main
 * hands over checked (`packs:get-manifest`). pack-host uses them to map
 * states and to check `draw`s, the renderer to place, clip and texture
 * the actors. The main API comes in as an argument, so it is unit-tested
 * under Node.
 *
 * - A pack gets asked for once it has an actor on stage and is installed
 *   at a version that fits the stage API; one request per pack and
 *   version. The answer is kept while that version stays installed, and
 *   dropped (released) once the pack is removed, no longer fits, or is
 *   installed at another version; a new version is asked for anew.
 * - A failed request (main says why not, or the call fails) gives one
 *   `not-drawn` line (`manifest-unavailable`) and no look; it is asked for
 *   again only once the pack has had no actor (or its version changed).
 */
import type { IpcResult } from '../shared/ipc';
import type { PackCharacter, PackManifest } from '../shared/pack-api';
import type { PackManifestResult, PackSpritesheetEntry } from '../shared/packs';
import type { PackLogEntry } from '../shared/sandbox';
import type { StageView } from '../shared/stage-view';
import { actorsByPack } from './pack-host/rules';

/** What one version of a pack is drawn with. */
export interface PackLook {
  readonly packId: string;
  readonly version: string;
  readonly manifest: PackManifest;
  /** Each spritesheet asset, by key. */
  readonly spritesheets: Readonly<Record<string, PackSpritesheetEntry>>;
  /** The manifest's character `characterId`, if it has one. */
  character(characterId: string): PackCharacter | undefined;
  /** The frame names of spritesheet asset `key`; undefined for any other key. */
  frames(key: string): ReadonlySet<string> | undefined;
}

/** `window.awp.packs`, as far as looks uses it. */
export interface LooksApi {
  getManifest(
    packId: string,
    version: string,
  ): Promise<IpcResult<PackManifestResult>>;
}

export interface LooksOptions {
  readonly api: LooksApi;
  /** Writes one run log line about a pack (`packs:log`). */
  readonly log: (entry: PackLogEntry) => void;
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

export interface Looks {
  /** Follows a StageView state: its `actors` and `packs`. */
  onView(view: Pick<StageView, 'actors' | 'packs'>): void;
  /** The look of the version of `packId` installed now, once it came. */
  get(packId: string): PackLook | undefined;
}

/** The PackLook of a manifest and its spritesheets. */
export function packLook(
  packId: string,
  version: string,
  manifest: PackManifest,
  spritesheets: Readonly<Record<string, PackSpritesheetEntry>>,
): PackLook {
  const characters = new Map(
    manifest.characters.map((character) => [character.id, character]),
  );
  const frames = new Map(
    Object.entries(spritesheets).map(([key, sheet]) => [
      key,
      new Set(Object.keys(sheet.data.frames)),
    ]),
  );
  return {
    packId,
    version,
    manifest,
    spritesheets,
    character: (characterId) => characters.get(characterId),
    frames: (key) => frames.get(key),
  };
}

interface Entry {
  readonly version: string;
  look: PackLook | undefined;
  failed: boolean;
}

export function createLooks({
  api,
  log,
  logError = console.error,
}: LooksOptions): Looks {
  const entries = new Map<string, Entry>();

  async function request(packId: string, entry: Entry): Promise<void> {
    let result: IpcResult<PackManifestResult> | undefined;
    try {
      result = await api.getManifest(packId, entry.version);
    } catch (error) {
      logError('[overlay] packs:get-manifest failed', error);
    }
    if (entries.get(packId) !== entry) {
      // Released while main was answering.
      return;
    }
    const data = result?.ok === true ? result.data : undefined;
    if (
      data === undefined ||
      !data.ok ||
      data.packId !== packId ||
      data.version !== entry.version
    ) {
      entry.failed = true;
      log({ kind: 'not-drawn', packId, reason: 'manifest-unavailable' });
      return;
    }
    entry.look = packLook(
      packId,
      data.version,
      data.manifest,
      data.spritesheets,
    );
  }

  return {
    onView(view) {
      const owners = actorsByPack(view.actors);
      const installed = new Map(
        view.packs.installed
          .filter((pack) => pack.compatibility.compatible)
          .map((pack) => [pack.id, pack.version]),
      );
      for (const [packId, entry] of entries) {
        if (
          installed.get(packId) !== entry.version ||
          (entry.failed && !owners.has(packId))
        ) {
          entries.delete(packId);
        }
      }
      for (const packId of owners.keys()) {
        const version = installed.get(packId);
        if (version === undefined || entries.has(packId)) {
          continue;
        }
        const entry: Entry = { version, look: undefined, failed: false };
        entries.set(packId, entry);
        void request(packId, entry);
      }
    },

    get(packId) {
      return entries.get(packId)?.look;
    },
  };
}
