import {
  PACK_IMPORT_MAX_TOTAL_BYTES,
  PACK_IMPORT_REPORTED_ISSUES_MAX,
  PACK_REJECTED_NAME_MAX_LENGTH,
} from './constants';
import {
  API_INCOMPATIBILITY_REASONS,
  type ApiIncompatibilityReason,
  type ApiVersion,
  apiVersionSchema,
  CHARACTER_HEIGHT_MAX,
  idSchema,
  labelSchema,
  MANIFEST_CHARACTERS_MAX,
  PACK_API_ISSUE_RULES,
  type PackApiIssueRule,
  packIdSchema,
  type PackManifest,
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
 * display layer words them. And StageView's `packImport` section: where the
 * one import at a time is (Story 3.2's second half), with `packs:confirm`'s
 * arguments; StageView's `packExport` section, where the one export at a
 * time is, the codes an export and a removal fail with, and the arguments
 * and answer of `packs:export` and `packs:remove` (Story 3.3's second
 * half).
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

/**
 * A character's key across packs: `<packId>/<characterId>`. settings.json
 * keeps a character's fixed parameters under it (Story 3.3); Story 3.4's
 * StageView actors name their character by it.
 */
export type CharacterKey = `${string}/${string}`;

/** The key of character `characterId` of pack `packId`. */
export function characterKey(
  packId: string,
  characterId: string,
): CharacterKey {
  return `${packId}/${characterId}`;
}

/** Whether `key` is `<packId>/<characterId>`, each part valid on its own. */
function isCharacterKey(key: string): boolean {
  const parts = key.split('/');
  return (
    parts.length === 2 &&
    packIdSchema.safeParse(parts[0]).success &&
    idSchema.safeParse(parts[1]).success
  );
}

/**
 * A CharacterKey: exactly one `/`, a pack id (packIdSchema) before it and a
 * character id (idSchema) after it.
 */
export const characterKeySchema = z.custom<CharacterKey>(
  (key) => typeof key === 'string' && isCharacterKey(key),
  { message: 'a character key is <packId>/<characterId>' },
);

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
 * `pack://<id>/<version>/` answers, worked out at install, sorted: the
 * entry, every `assets` path, and the image (`meta.image`) of each
 * declared spritesheet. Which one is the entry only the installed
 * `manifest.json` says. Story 3.9 adds its failure mark here as an
 * optional field.
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

/**
 * Whether an installed pack's `apiVersion` fits this stage
 * (checkApiCompatibility, Story 3.5): compatible, or why not and the API
 * version the pack declares. A pack can be installed and incompatible after
 * the app changed its API version; such a pack is not in the pool and its
 * entry is never handed to a sandbox.
 */
export const packCompatibilitySchema = z.discriminatedUnion('compatible', [
  z.strictObject({ compatible: z.literal(true) }),
  z.strictObject({
    compatible: z.literal(false),
    reason: z.enum(API_INCOMPATIBILITY_REASONS),
    required: apiVersionSchema,
  }),
]);

export type PackCompatibility = z.infer<typeof packCompatibilitySchema>;

/**
 * One installed pack as StageView carries it: index.json's entry without
 * `servedPaths`, with whether it fits this stage (Story 3.5).
 */
export const stagePackSchema = z.strictObject({
  ...installedPackShape,
  compatibility: packCompatibilitySchema,
});

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

// ---------------------------------------------------------------------------
// The import as StageView carries it (Story 3.2's second half).

/**
 * A name quoted in a published rejection: at most
 * PACK_REJECTED_NAME_MAX_LENGTH characters and then `…` (main/packs cuts
 * every quoted name and manifest path segment so before publishing).
 */
export const packQuotedNameSchema = z
  .string()
  .max(PACK_REJECTED_NAME_MAX_LENGTH + 1);

/** One manifest problem as published: PackManifestIssue, checked. */
export const packManifestIssueSchema = z.strictObject({
  code: z.string().min(1).max(64),
  rule: z.enum(PACK_API_ISSUE_RULES).exactOptional(),
  path: z
    .array(z.union([packQuotedNameSchema, z.int().nonnegative()]))
    .max(64)
    .readonly(),
});

/** A path-quoting rejection of `code`. */
function quotingRejection<const C extends PackRejectionCode>(code: C) {
  return z.strictObject({
    code: z.literal(code),
    path: packQuotedNameSchema,
  });
}

/** A rejection of `code` with nothing more to say. */
function plainRejection<const C extends PackRejectionCode>(code: C) {
  return z.strictObject({ code: z.literal(code) });
}

/**
 * PackRejection as published in StageView's `packImport` section: every
 * code with what its message needs. Its output is a PackRejection (checked
 * at compile time); an `invalid-manifest` here holds at most
 * PACK_IMPORT_REPORTED_ISSUES_MAX issues (the section counts the rest).
 */
export const packRejectionSchema = z.discriminatedUnion('code', [
  plainRejection('unreadable-file'),
  plainRejection('invalid-archive'),
  quotingRejection('unsafe-path'),
  quotingRejection('shortcut'),
  quotingRejection('name-conflict'),
  plainRejection('invalid-root'),
  z.strictObject({
    code: z.literal('too-large'),
    limit: z.enum(PACK_SIZE_LIMITS),
  }),
  plainRejection('missing-manifest'),
  plainRejection('manifest-not-json'),
  z.strictObject({
    code: z.literal('api-incompatible'),
    reason: z.enum(API_INCOMPATIBILITY_REASONS),
    required: apiVersionSchema,
  }),
  z.strictObject({
    code: z.literal('invalid-manifest'),
    issues: z
      .array(packManifestIssueSchema)
      .max(PACK_IMPORT_REPORTED_ISSUES_MAX)
      .readonly(),
  }),
  z.strictObject({
    code: z.literal('root-folder-mismatch'),
    folder: packQuotedNameSchema,
    packId: idSchema,
  }),
  quotingRejection('missing-file'),
  z.strictObject({
    code: z.literal('entry-unparsable'),
    reason: z.enum(PACK_ENTRY_PROBLEMS),
  }),
  quotingRejection('unsupported-image-format'),
  quotingRejection('invalid-spritesheet'),
  z.strictObject({
    code: z.literal('image-too-large'),
    limit: z.enum(PACK_IMAGE_LIMITS),
    path: packQuotedNameSchema.exactOptional(),
  }),
]) satisfies z.ZodType<PackRejection>;

/** The installed version a confirmation names: its name and version. */
const packNameAndVersionShape = {
  name: labelSchema,
  version: packVersionSchema,
};

/**
 * StageView's `packImport` section: where the one import at a time is
 * (main/packs' importer owns it), told apart by `phase`:
 * - `idle`: none yet this run;
 * - `reading`: the file dialog is open, a `.awpet` is being checked, or a
 *   confirmed pack is being installed (the 匯入 button is disabled);
 * - `confirm`: a pack of an installed id waits for the user to replace
 *   the installed version (`previous`) or not; `downgrade` when the new
 *   version is older;
 * - `result`, told apart by `outcome`: `installed` (the pack, now in the
 *   `packs` section), `rejected` (why, in English codes; `moreIssues`
 *   counts the manifest problems left out of an `invalid-manifest`, 0
 *   otherwise), `failed` (the install's failure code; the version
 *   installed before is unchanged) or `cancelled` (the user did not
 *   replace it).
 * Names and versions only, never a path on the user's disk.
 */
export const stagePackImportSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('idle') }),
  z.strictObject({ phase: z.literal('reading') }),
  z.strictObject({
    phase: z.literal('confirm'),
    packId: packIdSchema,
    ...packNameAndVersionShape,
    previous: z.strictObject(packNameAndVersionShape),
    downgrade: z.boolean(),
  }),
  z.discriminatedUnion('outcome', [
    z.strictObject({
      phase: z.literal('result'),
      outcome: z.literal('installed'),
      packId: packIdSchema,
      ...packNameAndVersionShape,
    }),
    z
      .strictObject({
        phase: z.literal('result'),
        outcome: z.literal('rejected'),
        rejection: packRejectionSchema,
        moreIssues: z.int().nonnegative(),
      })
      .refine(
        ({ rejection, moreIssues }) =>
          rejection.code === 'invalid-manifest' || moreIssues === 0,
        { message: 'only an invalid-manifest has more issues' },
      ),
    z.strictObject({
      phase: z.literal('result'),
      outcome: z.literal('failed'),
      code: z.enum(PACK_INSTALL_FAILURE_CODES),
    }),
    z.strictObject({
      phase: z.literal('result'),
      outcome: z.literal('cancelled'),
    }),
  ]),
]);

export type StagePackImport = z.infer<typeof stagePackImportSchema>;

/** Where every run's import starts. */
export const IDLE_PACK_IMPORT: StagePackImport = Object.freeze({
  phase: 'idle',
});

/** `packs:confirm`'s arguments: true replaces the installed version. */
export const packsConfirmInputSchema = z.tuple([z.boolean()]);

// ---------------------------------------------------------------------------
// Exporting and removing an installed pack (Story 3.3's second half).

/**
 * Every code an export fails with; nothing is written at the place picked
 * then:
 * - `not-installed`: the pack is not installed (any more), e.g. it was
 *   removed while the save dialog was open;
 * - `read-failed`: the installed folder is missing or cannot be read, or
 *   holds something that is not a regular file or folder;
 * - `write-failed`: the file could not be written at the place picked.
 */
export const PACK_EXPORT_FAILURE_CODES = [
  'not-installed',
  'read-failed',
  'write-failed',
] as const;

export type PackExportFailureCode = (typeof PACK_EXPORT_FAILURE_CODES)[number];

/**
 * Every code a removal fails with; nothing changes then (index.json and the
 * pack's folder are as they were):
 * - `not-installed`: no pack of that id is installed;
 * - `index-unwritable`: index.json could not be read at start, so this run
 *   does not write it;
 * - `index-write-failed`: index.json could not be written.
 */
export const PACK_REMOVE_FAILURE_CODES = [
  'not-installed',
  'index-unwritable',
  'index-write-failed',
] as const;

export type PackRemoveFailureCode = (typeof PACK_REMOVE_FAILURE_CODES)[number];

/**
 * StageView's `packExport` section: where the one export at a time is
 * (main/packs' exporter owns it), told apart by `phase`:
 * - `idle`: none yet this run;
 * - `saving`: the save dialog is open or the file is being written, for
 *   pack `packId` (every 匯出… button is disabled);
 * - `result`, told apart by `outcome`: `exported` (the pack's name and
 *   version as written) or `failed` (the export's failure code).
 * A cancelled save dialog goes back to the phase before. Ids, names and
 * versions only, never a path on the user's disk.
 */
export const stagePackExportSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('idle') }),
  z.strictObject({ phase: z.literal('saving'), packId: packIdSchema }),
  z.discriminatedUnion('outcome', [
    z.strictObject({
      phase: z.literal('result'),
      outcome: z.literal('exported'),
      packId: packIdSchema,
      ...packNameAndVersionShape,
    }),
    z.strictObject({
      phase: z.literal('result'),
      outcome: z.literal('failed'),
      packId: packIdSchema,
      code: z.enum(PACK_EXPORT_FAILURE_CODES),
    }),
  ]),
]);

export type StagePackExport = z.infer<typeof stagePackExportSchema>;

/** Where every run's export starts. */
export const IDLE_PACK_EXPORT: StagePackExport = Object.freeze({
  phase: 'idle',
});

/** `packs:export`'s arguments: the id of the installed pack to export. */
export const packsExportInputSchema = z.tuple([packIdSchema]);

/** `packs:remove`'s arguments: the id of the installed pack to remove. */
export const packsRemoveInputSchema = z.tuple([packIdSchema]);

/**
 * `packs:remove`'s answer: removed (gone from index.json; its folder is
 * removed too, or at the next start), or why nothing changed.
 */
export const packRemoveResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(PACK_REMOVE_FAILURE_CODES),
  }),
]);

export type PackRemoveResult = z.infer<typeof packRemoveResultSchema>;

// ---------------------------------------------------------------------------
// Handing a pack's entry to its sandbox (Story 3.5).

/**
 * Every code `packs:get-entry` fails with; nothing is handed over then:
 * - `not-installed`: no pack of that id is installed (any more);
 * - `api-incompatible`: its `apiVersion` does not fit this stage (checked
 *   again right before handing the entry over);
 * - `read-failed`: its entry file is missing or cannot be read.
 */
export const PACK_ENTRY_FAILURE_CODES = [
  'not-installed',
  'api-incompatible',
  'read-failed',
] as const;

export type PackEntryFailureCode = (typeof PACK_ENTRY_FAILURE_CODES)[number];

/** `packs:get-entry`'s arguments: the id of the installed pack. */
export const packsGetEntryInputSchema = z.tuple([packIdSchema]);

/**
 * `packs:get-entry`'s answer: the installed pack's id, version and entry
 * source (the file its manifest's `entry` names), or why not.
 */
export const packEntryResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    packId: packIdSchema,
    version: packVersionSchema,
    source: z.string().max(PACK_IMPORT_MAX_TOTAL_BYTES),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(PACK_ENTRY_FAILURE_CODES),
  }),
]);

export type PackEntryResult = z.infer<typeof packEntryResultSchema>;

// ---------------------------------------------------------------------------
// Reading an installed pack's manifest (Story 3.6).

/**
 * Why an installed version's own `manifest.json` could not be used
 * (main/packs reads it, main/settings works the characters out from it):
 * - `unreadable`: the file is missing or cannot be read;
 * - `not-json`: it is not JSON;
 * - `invalid-manifest`: it fails manifestSchema;
 * - `mismatch`: its `id` or `version` is not the folder's.
 */
export const INSTALLED_MANIFEST_FAILURES = [
  'unreadable',
  'not-json',
  'invalid-manifest',
  'mismatch',
] as const;

export type InstalledManifestFailure =
  (typeof INSTALLED_MANIFEST_FAILURES)[number];

/** An installed manifest, checked, or why not. */
export type InstalledManifestResult =
  | { readonly ok: true; readonly manifest: PackManifest }
  | {
      readonly ok: false;
      readonly code: InstalledManifestFailure;
      /** The error code, for `unreadable`. Never a path or file content. */
      readonly detail?: string;
    };
