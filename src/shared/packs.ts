import {
  type ApiIncompatibilityReason,
  type ApiVersion,
  apiVersionSchema,
  CHARACTER_HEIGHT_MAX,
  idSchema,
  labelSchema,
  MANIFEST_CHARACTERS_MAX,
  type PackApiIssueRule,
  packIdSchema,
  packPathSchema,
  packVersionSchema,
} from './pack-api';
import { z } from './zod-setup';

/**
 * main/packs' data (Story 3.2): the installed character packs. main/packs
 * owns them, keeps them in `userData/packs/index.json` (each pack's files
 * in `userData/packs/<packId>/<version>/`), and publishes them as
 * StageView's `packs` section. This file also lists the codes an import
 * is refused with and an install fails with: English codes only, the
 * display layer words them.
 */

/** The `schemaVersion` main/packs reads and writes in index.json. */
export const PACKS_SCHEMA_VERSION = 1;

/** Strictly increasing in code-unit order: sorted, each value once. */
function isSortedAndUnique(values: readonly string[]): boolean {
  return values.every(
    (value, i) => i === 0 || (values[i - 1] as string) < value,
  );
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** What the stage keeps of one character of an installed pack. */
export const packCharacterSummarySchema = z.strictObject({
  id: idSchema,
  name: labelSchema,
  /** Its declared height in base pixels (the panel hints when off 110). */
  height: z.number().min(1).max(CHARACTER_HEIGHT_MAX),
});

export type PackCharacterSummary = z.infer<typeof packCharacterSummarySchema>;

/** The fields an installed pack has in index.json and in StageView alike. */
const installedPackShape = {
  id: packIdSchema,
  name: labelSchema,
  version: packVersionSchema,
  apiVersion: apiVersionSchema,
  /** In the manifest's order; ids unique. */
  characters: z
    .array(packCharacterSummarySchema)
    .min(1)
    .max(MANIFEST_CHARACTERS_MAX)
    .refine((characters) => isUnique(characters.map((c) => c.id)), {
      message: 'character ids are unique',
    }),
};

/**
 * One installed pack in index.json. `servedPaths` are the files
 * `pack://<id>/<version>/` answers, worked out at install: the entry, every
 * `assets` path, and the image (`meta.image`) of each declared spritesheet.
 * Story 3.9 adds its failure mark here as an optional field.
 */
export const packIndexEntrySchema = z.strictObject({
  ...installedPackShape,
  servedPaths: z
    .array(packPathSchema)
    .min(1)
    .refine(isUnique, { message: 'served paths are unique' }),
});

export type PackIndexEntry = z.infer<typeof packIndexEntrySchema>;

/**
 * `packs/index.json`: `{ "schemaVersion": 1, "packs": [<entry>…] }`, one
 * entry per pack id (each pack keeps one version). The entries may come in
 * any order; main/packs sorts them by id when it reads the file.
 */
export const packIndexFileSchema = z.strictObject({
  schemaVersion: z.literal(PACKS_SCHEMA_VERSION),
  packs: z
    .array(packIndexEntrySchema)
    .refine((packs) => isUnique(packs.map((pack) => pack.id)), {
      message: 'pack ids are unique',
    }),
});

export type PackIndexFile = z.infer<typeof packIndexFileSchema>;

/** One installed pack as StageView carries it: index.json's entry without `servedPaths`. */
export const stagePackSchema = z.strictObject(installedPackShape);

export type StagePack = z.infer<typeof stagePackSchema>;

/**
 * StageView's `packs` section: the installed packs, sorted by id, each id
 * once.
 */
export const stagePacksSchema = z.strictObject({
  installed: z
    .array(stagePackSchema)
    .refine((packs) => isSortedAndUnique(packs.map((pack) => pack.id)), {
      message: 'installed packs are sorted by id, each id once',
    }),
});

export type StagePacks = z.infer<typeof stagePacksSchema>;

// ---------------------------------------------------------------------------
// Why an import is refused.

/**
 * Every code an import is refused with:
 * - `unreadable-file`: the file cannot be read (missing, a folder, no
 *   permission);
 * - `invalid-archive`: not a zip, damaged, encrypted, or packed in a way
 *   that cannot be unpacked;
 * - `unsafe-path`: an entry name (file or folder) that is not a pack path:
 *   each segment only `A-Z a-z 0-9 . _ -`, not empty, not ending in `.`
 *   (so no `.` or `..`), not a Windows device name; so no leading `/`,
 *   drive letter, `\`, space or non-ASCII character. Also a name longer
 *   than PACK_IMPORT_MAX_PATH_LENGTH or with more than
 *   PACK_IMPORT_MAX_PATH_SEGMENTS segments;
 * - `shortcut`: a symbolic link, or a `.lnk` file;
 * - `name-conflict`: two entries whose names differ only in case (or are
 *   the same), or a file and a folder of one name;
 * - `invalid-root`: the zip's root is not exactly one folder (`__MACOSX/`
 *   next to it counts as a second one);
 * - `too-large`: over PACK_IMPORT_MAX_ENTRIES (checked first),
 *   PACK_IMPORT_MAX_TOTAL_BYTES or PACK_IMPORT_MAX_FILES, or a file longer
 *   than it says;
 * - `missing-manifest`, `manifest-not-json`;
 * - `api-incompatible`: `apiVersion` does not fit this stage, checked
 *   before the rest of the manifest;
 * - `invalid-manifest`: the manifest fails the pack API schema;
 * - `root-folder-mismatch`: the root folder is not named after the
 *   manifest's `id`;
 * - `missing-file`: the entry, an `assets` path or a spritesheet's image is
 *   not in the pack;
 * - `entry-unparsable`: the entry is not a classic script that compiles
 *   (an ESM `import` or `export` is a syntax error there), or it has what
 *   SES 2.3.0 refuses to evaluate anywhere in its text (an HTML comment
 *   `<!--` or `-->`, an import expression, a direct `eval(`), or a
 *   `require` call (comments between the name and `(` included);
 * - `unsupported-image-format`: a declared image is not a PNG (by its
 *   header) or its name does not end in `.png`;
 * - `invalid-spritesheet`: a spritesheet whose path does not end in
 *   `.json`, that is not a JSON object with a `frames` object, whose
 *   `meta.image` is not a pack path relative to it, or whose `meta` has
 *   `related_multi_packs`;
 * - `image-too-large`: an image over PACK_IMPORT_MAX_IMAGE_SIDE, or all of
 *   them over PACK_IMPORT_MAX_TOTAL_PIXELS.
 */
export const PACK_REJECTION_CODES = [
  'unreadable-file',
  'invalid-archive',
  'unsafe-path',
  'shortcut',
  'name-conflict',
  'invalid-root',
  'too-large',
  'missing-manifest',
  'manifest-not-json',
  'api-incompatible',
  'invalid-manifest',
  'root-folder-mismatch',
  'missing-file',
  'entry-unparsable',
  'unsupported-image-format',
  'invalid-spritesheet',
  'image-too-large',
] as const;

export type PackRejectionCode = (typeof PACK_REJECTION_CODES)[number];

/**
 * Which size limit a `too-large` pack is over: the entries listed (folders
 * included), the total unpacked size, the file count, or a file that
 * unpacked to more bytes than it declared.
 */
export const PACK_SIZE_LIMITS = [
  'entry-count',
  'total-size',
  'file-count',
  'declared-size',
] as const;

export type PackSizeLimit = (typeof PACK_SIZE_LIMITS)[number];

/** Which image limit an `image-too-large` pack is over. */
export const PACK_IMAGE_LIMITS = ['side', 'total-pixels'] as const;

export type PackImageLimit = (typeof PACK_IMAGE_LIMITS)[number];

/** Why an entry is `entry-unparsable`. */
export const PACK_ENTRY_PROBLEMS = [
  'syntax-error',
  'html-comment',
  'dynamic-import',
  'direct-eval',
  'require',
] as const;

export type PackEntryProblem = (typeof PACK_ENTRY_PROBLEMS)[number];

/**
 * One problem in a manifest that fails the schema: zod's issue code, the
 * pack API rule when it is one of PACK_API_ISSUE_RULES (zod code
 * `custom`), and the field path (an unknown key's path ends with that
 * key).
 */
export interface PackManifestIssue {
  readonly code: string;
  readonly rule?: PackApiIssueRule;
  readonly path: readonly (string | number)[];
}

/**
 * Why an import is refused, with what the message needs. A `path` is a
 * name inside the pack (as the zip spells it, relative to the zip's root
 * for the entry checks, to the pack folder otherwise), never a path on the
 * user's disk. A name from the zip is quoted at most
 * PACK_REJECTED_NAME_MAX_LENGTH characters long (then `…`), with control
 * and bidi characters written as `\uXXXX`.
 */
export type PackRejection =
  | { readonly code: 'unreadable-file' }
  | { readonly code: 'invalid-archive' }
  | { readonly code: 'unsafe-path'; readonly path: string }
  | { readonly code: 'shortcut'; readonly path: string }
  | { readonly code: 'name-conflict'; readonly path: string }
  | { readonly code: 'invalid-root' }
  | { readonly code: 'too-large'; readonly limit: PackSizeLimit }
  | { readonly code: 'missing-manifest' }
  | { readonly code: 'manifest-not-json' }
  | {
      readonly code: 'api-incompatible';
      readonly reason: ApiIncompatibilityReason;
      /** The API version the pack declares, `<major>.<minor>`. */
      readonly required: ApiVersion;
    }
  | {
      readonly code: 'invalid-manifest';
      readonly issues: readonly PackManifestIssue[];
    }
  | {
      readonly code: 'root-folder-mismatch';
      readonly folder: string;
      readonly packId: string;
    }
  | { readonly code: 'missing-file'; readonly path: string }
  | { readonly code: 'entry-unparsable'; readonly reason: PackEntryProblem }
  | { readonly code: 'unsupported-image-format'; readonly path: string }
  | { readonly code: 'invalid-spritesheet'; readonly path: string }
  | {
      readonly code: 'image-too-large';
      readonly limit: PackImageLimit;
      /** The image over the side limit; none for the total. */
      readonly path?: string;
    };

// ---------------------------------------------------------------------------
// Why an install fails.

/**
 * Every code an install fails with; the pack installed before, if any,
 * stays as it was:
 * - `index-unwritable`: index.json could not be read at start, so this run
 *   does not write it;
 * - `stale-plan`: the installed version of the pack is no longer the one
 *   the plan was made against (another install came in between, or the
 *   plan was already used);
 * - `extract-failed`: the files could not be written to the temporary
 *   folder;
 * - `replace-failed`: the new folder could not be put in place;
 * - `index-write-failed`: index.json could not be written.
 */
export const PACK_INSTALL_FAILURE_CODES = [
  'index-unwritable',
  'stale-plan',
  'extract-failed',
  'replace-failed',
  'index-write-failed',
] as const;

export type PackInstallFailureCode =
  (typeof PACK_INSTALL_FAILURE_CODES)[number];
