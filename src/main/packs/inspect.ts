/**
 * main/packs (Story 3.2): checks a `.awpet` and answers either an install
 * plan or the first reason it is refused (an English code, with what the
 * message needs; the display layer words it). Nothing of the pack runs.
 *
 * After the zip checks (archive.ts):
 * 1. `manifest.json` is in the root folder and is JSON (a UTF-8 BOM is
 *    allowed).
 * 2. `apiVersion` alone is checked against this stage first
 *    (manifestApiVersionSchema, checkApiCompatibility), so a pack for a
 *    newer minor is told which API version it needs rather than failing on
 *    fields this stage does not know. Then the whole manifest
 *    (manifestSchema); its issues carry zod's code, the pack API rule, and
 *    the field path.
 * 3. The root folder is named after the manifest's `id`.
 * 4. The entry and every `assets` path are in the pack (names compare
 *    exactly, case included).
 * 5. The entry is a classic script that compiles: `new vm.Script` only
 *    compiles it, in strict mode as the sandbox evaluates it, and never
 *    runs it. An ESM `import` or `export` is a syntax error there. Then
 *    what SES 2.3.0 refuses to evaluate, matched with its own patterns
 *    (ses/src/transforms.js) over the whole text, comments and strings
 *    included: an HTML comment (`<!--`, `-->`), an import expression
 *    (`import(`, `import /* … *\/ (`; not `obj.import(`), a direct
 *    `eval(` (not `obj.eval(`). And a `require` call written the same way
 *    (`require(`, `require /* … *\/ (`), even after a `.`.
 * 6. Each spritesheet is a `.json` file holding a JSON object with a
 *    `frames` object (what PixiJS loads as a spritesheet), with no
 *    `meta.related_multi_packs` (PixiJS would fetch those sheets too), and
 *    a `meta.image` that is itself a pack path (no empty, `.` or `..`
 *    segment, so it is not normalized into something else); taken relative
 *    to the JSON, as PixiJS does, it names a file in the pack.
 * 7. Every declared image (image assets, spritesheet images) is a PNG by
 *    its header with a name ending in `.png`, at most
 *    PACK_IMPORT_MAX_IMAGE_SIDE wide and high, and all of them together at
 *    most PACK_IMPORT_MAX_TOTAL_PIXELS.
 *
 * The plan holds every file in memory (at most PACK_IMPORT_MAX_TOTAL_BYTES)
 * for install.ts, and says which version of the pack is installed now and
 * whether the new one is older; deciding whether to replace it is not done
 * here. Log lines carry codes, counts and the pack id only (once the
 * manifest passed its schema), never a path on the user's disk.
 */
import type { Buffer } from 'node:buffer';
import path from 'node:path';
import vm from 'node:vm';
import {
  PACK_IMPORT_MAX_IMAGE_SIDE,
  PACK_IMPORT_MAX_TOTAL_PIXELS,
} from '../../shared/constants';
import {
  checkApiCompatibility,
  manifestApiVersionSchema,
  manifestSchema,
  PACK_API_ISSUE_RULES,
  type PackApiIssueRule,
  type PackManifest,
  packPathSchema,
} from '../../shared/pack-api';
import type {
  PackEntryProblem,
  PackIndexEntry,
  PackManifestIssue,
  PackRejection,
} from '../../shared/packs';
import type { z } from '../../shared/zod-setup';
import { logEvent } from '../log/run-log';
import { isPlainObject } from '../persist/migrate';
import { readPackArchive } from './archive';
import { pngSize } from './png';
import { comparePackVersions } from './version';

/** The manifest's file name in the pack folder. */
export const MANIFEST_FILE = 'manifest.json';

/** The installed pack of one id, as far as a plan needs it. */
export interface InstalledPackLookup {
  find(
    packId: string,
  ): { readonly name: string; readonly version: string } | undefined;
}

/** What install.ts needs, and what the user is asked to confirm. */
export interface PackInstallPlan {
  readonly packId: string;
  readonly name: string;
  readonly version: string;
  /** The pack of this id installed when the plan was made, if any. */
  readonly previous: { readonly name: string; readonly version: string } | null;
  /** Whether `version` is older than `previous.version`. */
  readonly downgrade: boolean;
  /** The entry index.json gets. */
  readonly index: PackIndexEntry;
  /** Every file of the pack folder (manifest included), by pack path. */
  readonly files: ReadonlyMap<string, Buffer>;
}

export type PackInspection =
  | { readonly ok: true; readonly plan: PackInstallPlan }
  | { readonly ok: false; readonly rejection: PackRejection };

/** Thrown while checking to refuse the pack. */
class Refused extends Error {
  constructor(readonly rejection: PackRejection) {
    super(rejection.code);
  }
}

type ZodIssue = z.ZodError['issues'][number];

function log(message: string): void {
  logEvent('packs', message);
}

function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJson(data: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(withoutBom(data.toString('utf8'))) };
  } catch {
    // The SyntaxError message quotes the file.
    return { ok: false };
  }
}

/** The pack API rule of a `custom` issue, when it is one. */
function ruleOf(issue: ZodIssue): PackApiIssueRule | undefined {
  const rule = (issue as { params?: { rule?: unknown } }).params?.rule;
  return (PACK_API_ISSUE_RULES as readonly unknown[]).includes(rule)
    ? (rule as PackApiIssueRule)
    : undefined;
}

/** A manifest's schema issues, one per unknown key. */
function manifestIssues(issues: readonly ZodIssue[]): PackManifestIssue[] {
  return issues.flatMap((issue): PackManifestIssue[] => {
    const at = issue.path.map((part) =>
      typeof part === 'number' ? part : String(part),
    );
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        code: issue.code,
        path: [...at, key],
      }));
    }
    const rule = ruleOf(issue);
    return [
      rule === undefined
        ? { code: issue.code, path: at }
        : { code: issue.code, rule, path: at },
    ];
  });
}

/** SES 2.3.0's patterns (ses/src/transforms.js), and `require` alike. */
const HTML_COMMENT = /(?:<!--|-->)/;
const IMPORT_EXPRESSION = /(^|[^.]|\.\.\.)\bimport(\s*(?:\(|\/[/*]))/;
const DIRECT_EVAL = /(^|[^.])\beval(\s*\()/;
const REQUIRE_CALL = /\brequire(\s*(?:\(|\/[/*]))/;

/** Why an entry cannot be loaded, or undefined when it can (step 5). */
function entryProblem(
  source: string,
  file: string,
): PackEntryProblem | undefined {
  try {
    // Compiles only; the prefix keeps the line numbers.
    void new vm.Script(`'use strict';${source}`, { filename: file });
  } catch {
    return 'syntax-error';
  }
  if (HTML_COMMENT.test(source)) {
    return 'html-comment';
  }
  if (IMPORT_EXPRESSION.test(source)) {
    return 'dynamic-import';
  }
  if (DIRECT_EVAL.test(source)) {
    return 'direct-eval';
  }
  if (REQUIRE_CALL.test(source)) {
    return 'require';
  }
  return undefined;
}

/**
 * A spritesheet's image as a pack path (step 6), or undefined when the
 * sheet is not one this stage takes. `meta.image` is checked as written,
 * before joining: a `/` start, an empty, `.` or `..` segment would be
 * resolved into another file than the one checked.
 */
function spritesheetImage(sheetPath: string, data: Buffer): string | undefined {
  if (!sheetPath.endsWith('.json')) {
    return undefined;
  }
  const parsed = parseJson(data);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return undefined;
  }
  const { frames, meta } = parsed.value;
  if (!isPlainObject(frames) || !isPlainObject(meta)) {
    return undefined;
  }
  if (Object.hasOwn(meta, 'related_multi_packs')) {
    return undefined;
  }
  const image = meta.image;
  if (typeof image !== 'string' || !packPathSchema.safeParse(image).success) {
    return undefined;
  }
  const folder = path.posix.dirname(sheetPath);
  return folder === '.' ? image : `${folder}/${image}`;
}

/** A file the checks above made sure is there. */
function fileOf(files: ReadonlyMap<string, Buffer>, at: string): Buffer {
  const data = files.get(at);
  if (data === undefined) {
    throw new Refused({ code: 'missing-file', path: at });
  }
  return data;
}

/** Steps 1 to 3: the manifest, checked. */
function checkedManifest(
  root: string,
  files: ReadonlyMap<string, Buffer>,
): PackManifest {
  const data = files.get(MANIFEST_FILE);
  if (data === undefined) {
    throw new Refused({ code: 'missing-manifest' });
  }
  const json = parseJson(data);
  if (!json.ok) {
    throw new Refused({ code: 'manifest-not-json' });
  }
  const declared = manifestApiVersionSchema.safeParse(json.value);
  if (declared.success) {
    const compatibility = checkApiCompatibility(declared.data.apiVersion);
    if (!compatibility.compatible) {
      throw new Refused({
        code: 'api-incompatible',
        reason: compatibility.reason,
        required: compatibility.required,
      });
    }
  }
  const parsed = manifestSchema.safeParse(json.value);
  if (!parsed.success) {
    throw new Refused({
      code: 'invalid-manifest',
      issues: manifestIssues(parsed.error.issues),
    });
  }
  if (root !== parsed.data.id) {
    throw new Refused({
      code: 'root-folder-mismatch',
      folder: root,
      packId: parsed.data.id,
    });
  }
  return parsed.data;
}

/** Steps 4 to 7: what the manifest names; answers the served paths. */
function checkedFiles(
  manifest: PackManifest,
  files: ReadonlyMap<string, Buffer>,
): string[] {
  const assets = Object.values(manifest.assets);
  for (const at of [manifest.entry, ...assets.map((asset) => asset.path)]) {
    fileOf(files, at);
  }

  const problem = entryProblem(
    fileOf(files, manifest.entry).toString('utf8'),
    manifest.entry,
  );
  if (problem !== undefined) {
    throw new Refused({ code: 'entry-unparsable', reason: problem });
  }

  const served = new Set<string>([manifest.entry]);
  const images = new Set<string>();
  for (const asset of assets) {
    served.add(asset.path);
    if (asset.kind === 'image') {
      images.add(asset.path);
      continue;
    }
    const image = spritesheetImage(asset.path, fileOf(files, asset.path));
    if (image === undefined) {
      throw new Refused({ code: 'invalid-spritesheet', path: asset.path });
    }
    fileOf(files, image);
    served.add(image);
    images.add(image);
  }

  let totalPixels = 0;
  for (const image of images) {
    const size = image.endsWith('.png') ? pngSize(fileOf(files, image)) : null;
    if (size === null) {
      throw new Refused({ code: 'unsupported-image-format', path: image });
    }
    if (
      size.width > PACK_IMPORT_MAX_IMAGE_SIDE ||
      size.height > PACK_IMPORT_MAX_IMAGE_SIDE
    ) {
      throw new Refused({
        code: 'image-too-large',
        limit: 'side',
        path: image,
      });
    }
    totalPixels += size.width * size.height;
  }
  if (totalPixels > PACK_IMPORT_MAX_TOTAL_PIXELS) {
    throw new Refused({ code: 'image-too-large', limit: 'total-pixels' });
  }

  return [...served].sort();
}

/** The log line's reason: the code, and how many issues a manifest has. */
function describe(rejection: PackRejection): string {
  return rejection.code === 'invalid-manifest'
    ? `${rejection.code} (${rejection.issues.length} issues)`
    : rejection.code;
}

/**
 * Checks the `.awpet` at `file` and answers an install plan, or why it is
 * refused. `installed` says which version of the pack is installed now.
 * Rejects only on a bug, never because of the pack.
 */
export async function inspectPack(
  file: string,
  installed: InstalledPackLookup,
): Promise<PackInspection> {
  const archive = await readPackArchive(file);
  if (!archive.ok) {
    log(`refused a pack: ${describe(archive.rejection)}`);
    return archive;
  }
  let manifest: PackManifest | undefined;
  let servedPaths: string[];
  try {
    manifest = checkedManifest(archive.root, archive.files);
    servedPaths = checkedFiles(manifest, archive.files);
  } catch (error) {
    if (!(error instanceof Refused)) {
      throw error;
    }
    // The id only once the manifest passed its schema.
    const which = manifest === undefined ? 'a pack' : `pack ${manifest.id}`;
    log(`refused ${which}: ${describe(error.rejection)}`);
    return { ok: false, rejection: error.rejection };
  }

  const current = installed.find(manifest.id);
  const previous =
    current === undefined
      ? null
      : { name: current.name, version: current.version };
  const downgrade =
    previous !== null &&
    comparePackVersions(manifest.version, previous.version) < 0;
  const plan: PackInstallPlan = {
    packId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    previous,
    downgrade,
    index: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      characters: manifest.characters.map(({ id, name, height }) => ({
        id,
        name,
        height,
      })),
      servedPaths,
    },
    files: archive.files,
  };
  const note =
    previous === null
      ? ''
      : downgrade
        ? '; older than the installed version'
        : '; replaces the installed version';
  log(
    `checked pack ${manifest.id}: ${archive.files.size} files, ready to install${note}`,
  );
  return { ok: true, plan };
}
