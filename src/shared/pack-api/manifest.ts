import { stateCodeSchema } from '../states';
import { z } from '../zod-setup';
import {
  addRuleIssue,
  idSchema,
  labelSchema,
  type PackApiIssueRule,
  repeatedIndexes,
  ruleIssue,
  withoutProtoKey,
} from './common';
import { characterDefaultsSchema } from './fixed-params';
import { paramDeclSchema } from './params';
import { apiVersionSchema } from './version';

/**
 * A pack's `manifest.json` (Epic 3). Story 3.2 checks `apiVersion` with
 * manifestApiVersionSchema first, then the whole file with manifestSchema.
 * Coordinates are a character's local coordinates: origin at the centre of
 * its feet, in base pixels, y pointing down.
 */

/** Windows device names, which cannot be a folder name there. */
const WINDOWS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * A pack id: an id that also works as the host of `pack://<packId>/` and as
 * a folder name on every platform. Not all digits and not starting with
 * `0x` (Chromium turns such a host of a standard scheme into an IPv4
 * address), and not a Windows device name.
 */
export const packIdSchema = idSchema.superRefine((id, ctx) => {
  if (/^[0-9]+$/.test(id)) {
    addRuleIssue(ctx, 'pack-id-all-digits', 'a pack id is not all digits', []);
  }
  if (id.startsWith('0x')) {
    addRuleIssue(
      ctx,
      'pack-id-hex-prefix',
      'a pack id does not start with 0x',
      [],
    );
  }
  if (WINDOWS_DEVICE_NAMES.has(id)) {
    addRuleIssue(
      ctx,
      'pack-id-device-name',
      'a pack id is not a Windows device name',
      [],
    );
  }
});

/** Longest pack version, in characters. */
export const PACK_VERSION_MAX_LENGTH = 32;

/**
 * `MAJOR.MINOR.PATCH`, digits only and no leading zeros (no prerelease or
 * build part), at most PACK_VERSION_MAX_LENGTH characters: it becomes a
 * folder name under `userData/packs/<packId>/`.
 */
export const packVersionSchema = z
  .string()
  .max(PACK_VERSION_MAX_LENGTH)
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);

/**
 * One segment of a pack path: `A-Z a-z 0-9 . _ -`, not empty and not ending
 * in `.` (so not `.`, `..` or `...` either): Windows drops a name's trailing
 * dots, which would make `a.` and `a` the same file.
 */
const PACK_PATH_SEGMENT = /^[A-Za-z0-9._-]*[A-Za-z0-9_-]$/;

function isPackPath(path: string): boolean {
  return path.split('/').every((segment) => PACK_PATH_SEGMENT.test(segment));
}

/**
 * A file inside the pack, relative to its folder, written the one way its
 * `pack://` URL is: segments split by `/`, each a PACK_PATH_SEGMENT. So no
 * leading or doubled `/`, no `.` or `..` segment, no `\`, drive letter, `%`,
 * `#`, `?` or control character. The import (3.2) still checks every path it
 * unpacks.
 */
export const packPathSchema = z
  .string()
  .refine(isPackPath, ruleIssue('invalid-pack-path', 'not a pack path'));

/** The pack's entry script: a pack path ending in `.js`. */
export const entryPathSchema = packPathSchema.refine(
  (path) => path.endsWith('.js'),
  ruleIssue('entry-not-js', 'the entry ends in .js'),
);

export const ASSET_KINDS = ['image', 'spritesheet'] as const;

/** One image, or a PixiJS spritesheet JSON. */
export const assetSchema = z.strictObject({
  kind: z.enum(ASSET_KINDS),
  path: packPathSchema,
});

export type PackAsset = z.infer<typeof assetSchema>;

/** A rectangle in local coordinates; width and height above 0. */
export const localBoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export type LocalBox = z.infer<typeof localBoxSchema>;

/** A point in local coordinates. */
export const localPointSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});

export type LocalPoint = z.infer<typeof localPointSchema>;

/** The tallest a character may declare itself, in base pixels. */
export const CHARACTER_HEIGHT_MAX = 1000;

/** Most characters one pack may have. */
export const MANIFEST_CHARACTERS_MAX = 64;

/**
 * One character. Its own fields only: unique parameter keys and states,
 * `fallback`, the hitbox inside the bounds and asset references are checked
 * by manifestSchema.
 */
const characterSchema = z.strictObject({
  /** Stable across pack versions; a renamed id is a character that left. */
  id: idSchema,
  name: labelSchema,
  /** Its height in base pixels (RECOMMENDED_CHARACTER_HEIGHT is 110). */
  height: z.number().min(1).max(CHARACTER_HEIGHT_MAX),
  params: z.array(paramDeclSchema),
  /** The states the pack draws itself, each once. */
  states: z.array(stateCodeSchema).min(1),
  /**
   * For a state not in `states`, the state in `states` the pack is sent
   * instead. A missing state with no entry here is drawn by the stage as a
   * placeholder.
   */
  fallback: withoutProtoKey(
    z.partialRecord(stateCodeSchema, stateCodeSchema),
  ).exactOptional(),
  /**
   * What the pointer hits, times the `scale` fixed parameter; wholly
   * inside `bounds` (edges may touch).
   */
  hitbox: localBoxSchema,
  /** Drawing outside it is clipped. */
  bounds: localBoxSchema,
  /** Where the stage draws the name tag and state badge. */
  anchor: localPointSchema,
  defaults: characterDefaultsSchema.exactOptional(),
  /** Whether the pack may send `bitmap` commands for it (checked in 3.6). */
  advancedBitmap: z.boolean().exactOptional(),
});

export type PackCharacter = z.infer<typeof characterSchema>;

type ManifestFields = {
  readonly assets: Readonly<Record<string, unknown>>;
  readonly characters: readonly PackCharacter[];
  readonly projectiles?: Readonly<Record<string, string>>;
};

/** Whether `inner` lies wholly inside `outer`; edges may touch. */
function isInside(inner: LocalBox, outer: LocalBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The cross-field rules: references, repeats, `fallback`, the hitbox. */
function checkManifest(manifest: ManifestFields, ctx: z.RefinementCtx): void {
  const hasAsset = (key: string) => Object.hasOwn(manifest.assets, key);
  const issue = (
    rule: PackApiIssueRule,
    message: string,
    path: PropertyKey[],
  ) => addRuleIssue(ctx, rule, message, path);

  for (const i of repeatedIndexes(manifest.characters.map((c) => c.id))) {
    issue('duplicate-character-id', 'character ids are unique', [
      'characters',
      i,
      'id',
    ]);
  }

  manifest.characters.forEach((character, c) => {
    const at = ['characters', c];

    for (const p of repeatedIndexes(character.params.map((p) => p.key))) {
      issue(
        'duplicate-param-key',
        'parameter keys are unique within a character',
        [...at, 'params', p, 'key'],
      );
    }
    character.params.forEach((param, p) => {
      if (param.type !== 'asset') {
        return;
      }
      param.options.forEach((key, o) => {
        if (!hasAsset(key)) {
          issue('missing-asset-option', 'an asset option is a key in assets', [
            ...at,
            'params',
            p,
            'options',
            o,
          ]);
        }
      });
      if (!hasAsset(param.default)) {
        issue('missing-asset-default', 'an asset default is a key in assets', [
          ...at,
          'params',
          p,
          'default',
        ]);
      }
    });

    for (const s of repeatedIndexes(character.states)) {
      issue('duplicate-state', 'states are unique', [...at, 'states', s]);
    }
    for (const [missing, shown] of Object.entries(character.fallback ?? {})) {
      if ((character.states as readonly string[]).includes(missing)) {
        issue(
          'fallback-key-in-states',
          'a fallback key is a state not in states',
          [...at, 'fallback', missing],
        );
      }
      if (shown === undefined || !character.states.includes(shown)) {
        issue(
          'fallback-value-not-in-states',
          'a fallback value is a state in states',
          [...at, 'fallback', missing],
        );
      }
    }

    if (!isInside(character.hitbox, character.bounds)) {
      issue('hitbox-outside-bounds', 'the hitbox lies inside the bounds', [
        ...at,
        'hitbox',
      ]);
    }
  });

  for (const [id, key] of Object.entries(manifest.projectiles ?? {})) {
    if (!hasAsset(key)) {
      issue('missing-projectile-asset', 'a projectile is a key in assets', [
        'projectiles',
        id,
      ]);
    }
  }
}

/** `manifest.json`. */
export const manifestSchema = z
  .strictObject({
    id: packIdSchema,
    name: labelSchema,
    version: packVersionSchema,
    apiVersion: apiVersionSchema,
    entry: entryPathSchema,
    /** Images and spritesheets by key; draw commands name them by key. */
    assets: withoutProtoKey(z.record(idSchema, assetSchema)),
    characters: z.array(characterSchema).min(1).max(MANIFEST_CHARACTERS_MAX),
    /** Projectile id → the key in `assets` it is drawn with (Epic 4). */
    projectiles: withoutProtoKey(z.record(idSchema, idSchema)).exactOptional(),
  })
  .superRefine(checkManifest);

export type PackManifest = z.infer<typeof manifestSchema>;
