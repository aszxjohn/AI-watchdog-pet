/**
 * main/settings' characters (Story 3.6, AD-23): works out each character's
 * effective parameters and fixed parameters and offers them to StageView
 * as its `characters` section (get() and onChange(), as main/packs offers
 * `packs`). The one place they are worked out; the rules themselves are
 * src/shared/params' pure functions, and renderers only read the section.
 *
 * - Which characters: every character of every installed pack that fits
 *   this stage's API, whether its pack is 上場 and whether it joins the
 *   pool or not (Story 3.6's `spawn` and Epic 5's editing page need them
 *   all), keyed `<packId>/<characterId>`, keys sorted.
 * - The manifests: main/packs reads each installed version's own
 *   `manifest.json` (handed in as `readManifest`; this module does not
 *   import main/packs), again on every change of the installed packs: a
 *   pack can be installed again over the same version, so its id and
 *   version say nothing about what its manifest holds. A pack whose
 *   manifest cannot be read, is not JSON, fails the schema or is not that
 *   pack's (src/shared/packs' INSTALLED_MANIFEST_FAILURES), or that does
 *   not fit this stage's API, is left out with one line naming its id;
 *   the other packs are not affected.
 * - Parameters: the declared defaults. settings.json has no parameter
 *   overrides yet (Epic 5's editing page adds them); effectiveParams
 *   already takes them by AD-11's rule.
 * - Fixed parameters: settings' `fixedOverrides` (only `inPool` so far) ??
 *   the manifest character's `defaults` ?? the stage defaults
 *   (effectiveFixed).
 * - Worked out again only when the settings values or the installed packs
 *   change; listeners hear only a result that differs.
 * - It follows settings and packs through watch(), which main.ts calls
 *   right after createStageView, as main/pool's assigner does with
 *   watchPool(): StageView hears a packs change first, so a new character
 *   never reaches a renderer ahead of the `packs` delta that lists its
 *   pack. Until then the section is what they were at creation; watch()
 *   catches up with what changed in between.
 *
 * Log lines carry pack ids, codes and counts, never a character's values.
 */
import type { PackManifest } from '../../shared/pack-api';
import {
  characterKey,
  type InstalledManifestResult,
  type StagePack,
} from '../../shared/packs';
import { effectiveFixed, effectiveParams } from '../../shared/params';
import type { SettingsState, SettingsValues } from '../../shared/settings';
import type {
  StageCharacter,
  StageCharacters,
  StageViewCharactersSections,
  StageViewPacksSections,
} from '../../shared/stage-view';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';

export type CharactersListener = (
  sections: StageViewCharactersSections,
) => void;

export interface CharactersOptions {
  /** main/settings: the fixed parameter overrides. */
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  /** main/packs' store: the installed packs and whether each fits. */
  readonly packs: {
    get(): StageViewPacksSections;
    onChange(listener: (sections: StageViewPacksSections) => void): () => void;
  };
  /**
   * Reads the manifest of an installed pack's version (main/packs'
   * readInstalledManifest): the manifest, checked, or why not.
   */
  readonly readManifest: (
    packId: string,
    version: string,
  ) => InstalledManifestResult;
}

export interface CharactersSource {
  /** The `characters` section. */
  get(): StageViewCharactersSections;
  /** Hears the section after each change of it. Returns an unsubscribe. */
  onChange(listener: CharactersListener): () => void;
  /**
   * Starts following settings and the installed packs, first catching up
   * with any change made since creation (the manifests are read again only
   * when the installed packs changed). main.ts calls it right after
   * createStageView, so StageView hears each such change first. Only the
   * first call does anything.
   */
  watch(): void;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('settings', message, level);
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The manifest of each pack of `installed` that fits this stage and could
 * be read, by pack id; one line for each one left out.
 */
function manifestsOf(
  installed: readonly StagePack[],
  readManifest: CharactersOptions['readManifest'],
): ReadonlyMap<string, PackManifest> {
  const manifests = new Map<string, PackManifest>();
  for (const pack of installed) {
    if (!pack.compatibility.compatible) {
      log(
        `pack ${pack.id}: left out of characters (api-incompatible: ${pack.compatibility.reason}, needs API ${pack.compatibility.required})`,
        'warn',
      );
      continue;
    }
    let read: InstalledManifestResult;
    try {
      read = readManifest(pack.id, pack.version);
    } catch (error) {
      log(
        `pack ${pack.id}: left out of characters (manifest read failed: ${errorCode(error)})`,
        'error',
      );
      continue;
    }
    if (!read.ok) {
      const detail = read.detail === undefined ? '' : `: ${read.detail}`;
      log(
        `pack ${pack.id}: left out of characters (manifest ${read.code}${detail})`,
        'error',
      );
      continue;
    }
    manifests.set(pack.id, read.manifest);
  }
  return manifests;
}

/** Every character of `manifests` with its effective values, keys sorted. */
function charactersOf(
  manifests: ReadonlyMap<string, PackManifest>,
  values: Pick<SettingsValues, 'fixedOverrides'>,
): StageCharacters {
  const entries: [string, StageCharacter][] = [];
  for (const [packId, manifest] of manifests) {
    for (const character of manifest.characters) {
      const key = characterKey(packId, character.id);
      const override = Object.hasOwn(values.fixedOverrides, key)
        ? values.fixedOverrides[key]
        : undefined;
      entries.push([
        key,
        Object.freeze({
          params: effectiveParams(character.params),
          fixed: effectiveFixed(character.defaults, override),
        }),
      ]);
    }
  }
  entries.sort(([a], [b]) => compareKeys(a, b));
  return Object.freeze(Object.fromEntries(entries)) as StageCharacters;
}

export function createCharacters({
  settings,
  packs,
  readManifest,
}: CharactersOptions): CharactersSource {
  let values = settings.get().values;
  /** The installed packs the manifests were read for. */
  let readFor = packs.get().packs.installed;
  let manifests = manifestsOf(readFor, readManifest);
  let section: StageViewCharactersSections = {
    characters: charactersOf(manifests, values),
  };
  let compared = JSON.stringify(section.characters);
  const listeners = new Set<CharactersListener>();
  let watching = false;

  function describe(): string {
    return `${plural(Object.keys(section.characters).length, 'character', 'characters')} of ${plural(manifests.size, 'pack', 'packs')}`;
  }

  log(`characters: ${describe()}`);

  /** Works the section out again; tells the listeners when it changed. */
  function refresh(): void {
    const characters = charactersOf(manifests, values);
    const text = JSON.stringify(characters);
    if (text === compared) {
      return;
    }
    compared = text;
    section = { characters };
    log(`characters changed: ${describe()}`);
    const current = section;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  return {
    get: () => section,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    watch() {
      if (watching) {
        return;
      }
      watching = true;
      settings.onChange((state) => {
        values = state.values;
        refresh();
      });
      packs.onChange((next) => {
        readFor = next.packs.installed;
        manifests = manifestsOf(readFor, readManifest);
        refresh();
      });
      // What changed between creation and now.
      values = settings.get().values;
      const installed = packs.get().packs.installed;
      if (installed !== readFor) {
        readFor = installed;
        manifests = manifestsOf(readFor, readManifest);
      }
      refresh();
    },
  };
}
