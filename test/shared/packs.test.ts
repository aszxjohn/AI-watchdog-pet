import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PACK_ENTRY_PROBLEMS,
  PACK_IMAGE_LIMITS,
  PACK_INSTALL_FAILURE_CODES,
  PACK_REJECTION_CODES,
  PACK_SIZE_LIMITS,
  IDLE_PACK_IMPORT,
  packCharacterSummarySchema,
  packIndexEntrySchema,
  packIndexFileSchema,
  packManifestIssueSchema,
  packRejectionSchema,
  PACKS_SCHEMA_VERSION,
  packsConfirmInputSchema,
  stagePackImportSchema,
  stagePackSchema,
  stagePacksSchema,
  type PackRejection,
  type PackRejectionCode,
} from '../../src/shared/packs';
import {
  PACK_IMPORT_MAX_ENTRIES,
  PACK_IMPORT_MAX_FILES,
  PACK_IMPORT_MAX_IMAGE_SIDE,
  PACK_IMPORT_MAX_PATH_LENGTH,
  PACK_IMPORT_MAX_PATH_SEGMENTS,
  PACK_IMPORT_MAX_TOTAL_BYTES,
  PACK_IMPORT_MAX_TOTAL_PIXELS,
  PACK_IMPORT_REPORTED_ISSUES_MAX,
  PACK_REJECTED_NAME_MAX_LENGTH,
} from '../../src/shared/constants';
import { expectRejected, expectRoundTrip } from './schema-helpers';

const CHARACTER = { id: 'probe-a', name: '探針甲', height: 110 };
const STAGE_PACK = {
  id: 'sample-pack',
  name: '樣本包',
  version: '1.4.0',
  apiVersion: '1.0',
  characters: [CHARACTER, { id: 'probe-b', name: '探針乙', height: 96.5 }],
};
const ENTRY = {
  ...STAGE_PACK,
  servedPaths: [
    'dist/entry.js',
    'img/body.png',
    'img/sheet.json',
    'img/sheet.png',
  ],
};

describe('the import limits (chosen 2026-11-16)', () => {
  it('are 64 MiB unpacked, 512 files, 4096 pixels a side, 64 million pixels in all', () => {
    expect(PACK_IMPORT_MAX_TOTAL_BYTES).toBe(67_108_864);
    expect(PACK_IMPORT_MAX_FILES).toBe(512);
    expect(PACK_IMPORT_MAX_IMAGE_SIDE).toBe(4096);
    expect(PACK_IMPORT_MAX_TOTAL_PIXELS).toBe(64_000_000);
  });

  it('also bound the entries (folders included), name length and depth, and how much of a name a rejection quotes', () => {
    expect(PACK_IMPORT_MAX_ENTRIES).toBe(2 * PACK_IMPORT_MAX_FILES);
    expect(PACK_IMPORT_MAX_PATH_LENGTH).toBe(255);
    expect(PACK_IMPORT_MAX_PATH_SEGMENTS).toBe(32);
    expect(PACK_REJECTED_NAME_MAX_LENGTH).toBe(200);
  });
});

describe('packCharacterSummarySchema', () => {
  it('round-trips a character', () => {
    expectRoundTrip(packCharacterSummarySchema, CHARACTER);
  });

  it.each([
    ['height 0', { ...CHARACTER, height: 0 }],
    ['a height over 1000', { ...CHARACTER, height: 1001 }],
    ['a blank name', { ...CHARACTER, name: '  ' }],
    ['a bad id', { ...CHARACTER, id: 'Probe' }],
    ['an extra field', { ...CHARACTER, params: [] }],
  ])('rejects %s', (_label, value) => {
    expectRejected(packCharacterSummarySchema, value);
  });
});

describe('packIndexEntrySchema', () => {
  it('round-trips an entry', () => {
    expectRoundTrip(packIndexEntrySchema, ENTRY);
  });

  it.each([
    ['no served paths', { ...ENTRY, servedPaths: [] }],
    ['a served path twice', { ...ENTRY, servedPaths: ['a.js', 'a.js'] }],
    ['a served path with ..', { ...ENTRY, servedPaths: ['../a.js'] }],
    ['a served path with a leading /', { ...ENTRY, servedPaths: ['/a.js'] }],
    [
      'a served path that is a device name',
      { ...ENTRY, servedPaths: ['con.js'] },
    ],
    ['no characters', { ...ENTRY, characters: [] }],
    ['a character id twice', { ...ENTRY, characters: [CHARACTER, CHARACTER] }],
    ['a pack id that is a device name', { ...ENTRY, id: 'lpt0' }],
    ['a version with a prerelease', { ...ENTRY, version: '1.0.0-beta' }],
    ['a bad apiVersion', { ...ENTRY, apiVersion: '1' }],
    ['no servedPaths', STAGE_PACK],
    ['an extra field', { ...ENTRY, enabled: true }],
  ])('rejects %s', (_label, value) => {
    expectRejected(packIndexEntrySchema, value);
  });
});

describe('packIndexFileSchema', () => {
  it('round-trips an index, in any order, and an empty one', () => {
    expectRoundTrip(packIndexFileSchema, {
      schemaVersion: 1,
      packs: [ENTRY, { ...ENTRY, id: 'another-pack' }],
    });
    expectRoundTrip(packIndexFileSchema, { schemaVersion: 1, packs: [] });
    expect(PACKS_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    [
      'one pack id twice (one version per pack)',
      { schemaVersion: 1, packs: [ENTRY, { ...ENTRY, version: '2.0.0' }] },
    ],
    ['schemaVersion 2', { schemaVersion: 2, packs: [] }],
    ['no schemaVersion', { packs: [] }],
    ['no packs', { schemaVersion: 1 }],
    ['an extra field', { schemaVersion: 1, packs: [], failed: [] }],
  ])('rejects %s', (_label, value) => {
    expectRejected(packIndexFileSchema, value);
  });
});

describe('stagePacksSchema', () => {
  it('round-trips the installed packs sorted by id, and none', () => {
    expectRoundTrip(stagePacksSchema, {
      installed: [{ ...STAGE_PACK, id: 'another-pack' }, STAGE_PACK],
    });
    expectRoundTrip(stagePacksSchema, { installed: [] });
  });

  it.each([
    [
      'out of order',
      { installed: [STAGE_PACK, { ...STAGE_PACK, id: 'another-pack' }] },
    ],
    ['one pack twice', { installed: [STAGE_PACK, STAGE_PACK] }],
    ['served paths, which stay in main', { installed: [ENTRY] }],
    ['no installed list', {}],
  ])('rejects %s', (_label, value) => {
    expectRejected(stagePacksSchema, value);
  });

  it('a stage pack is an index entry without servedPaths', () => {
    expect(Object.keys(stagePackSchema.shape)).toStrictEqual(
      Object.keys(packIndexEntrySchema.shape).filter(
        (key) => key !== 'servedPaths',
      ),
    );
  });
});

describe('the code lists', () => {
  it.each([
    ['PACK_REJECTION_CODES', PACK_REJECTION_CODES],
    ['PACK_SIZE_LIMITS', PACK_SIZE_LIMITS],
    ['PACK_IMAGE_LIMITS', PACK_IMAGE_LIMITS],
    ['PACK_ENTRY_PROBLEMS', PACK_ENTRY_PROBLEMS],
    ['PACK_INSTALL_FAILURE_CODES', PACK_INSTALL_FAILURE_CODES],
  ])('%s lists each code once, in kebab-case', (_name, codes) => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it('every rejection code has its shape in PackRejection, and no other code does', () => {
    expectTypeOf<PackRejection['code']>().toEqualTypeOf<PackRejectionCode>();
  });
});

/** One published rejection of every code. */
const REJECTIONS: Readonly<Record<PackRejectionCode, PackRejection>> = {
  'unreadable-file': { code: 'unreadable-file' },
  'invalid-archive': { code: 'invalid-archive' },
  'unsafe-path': { code: 'unsafe-path', path: 'pack/../x.js' },
  shortcut: { code: 'shortcut', path: 'pack/link' },
  'name-conflict': { code: 'name-conflict', path: 'pack/A.png' },
  'invalid-root': { code: 'invalid-root' },
  'too-large': { code: 'too-large', limit: 'declared-size' },
  'missing-manifest': { code: 'missing-manifest' },
  'manifest-not-json': { code: 'manifest-not-json' },
  'api-incompatible': {
    code: 'api-incompatible',
    reason: 'major-mismatch',
    required: '2.0',
  },
  'invalid-manifest': {
    code: 'invalid-manifest',
    issues: [
      { code: 'unrecognized_keys', path: ['extra'] },
      {
        code: 'custom',
        rule: 'hitbox-outside-bounds',
        path: ['characters', 0, 'hitbox'],
      },
    ],
  },
  'root-folder-mismatch': {
    code: 'root-folder-mismatch',
    folder: 'my-pack',
    packId: 'other-pack',
  },
  'missing-file': { code: 'missing-file', path: 'img/a.png' },
  'entry-unparsable': { code: 'entry-unparsable', reason: 'direct-eval' },
  'unsupported-image-format': {
    code: 'unsupported-image-format',
    path: 'img/a.gif',
  },
  'invalid-spritesheet': { code: 'invalid-spritesheet', path: 'img/a.json' },
  'image-too-large': { code: 'image-too-large', limit: 'side', path: 'a.png' },
};

describe('packRejectionSchema', () => {
  it.each(PACK_REJECTION_CODES.map((code) => [code]))(
    'round-trips a %s rejection',
    (code) => {
      expectRoundTrip(packRejectionSchema, REJECTIONS[code]);
    },
  );

  it('round-trips an image over the total with no path, a name cut at the limit, and a manifest with no issue listed', () => {
    expectRoundTrip(packRejectionSchema, {
      code: 'image-too-large',
      limit: 'total-pixels',
    });
    expectRoundTrip(packRejectionSchema, {
      code: 'unsafe-path',
      path: `${'a'.repeat(PACK_REJECTED_NAME_MAX_LENGTH)}…`,
    });
    expectRoundTrip(packRejectionSchema, {
      code: 'invalid-manifest',
      issues: [],
    });
  });

  it.each([
    ['an unknown code', { code: 'too-old' }],
    ['a path missing', { code: 'missing-file' }],
    ['an extra field', { code: 'invalid-root', path: 'x' }],
    [
      'a name longer than a quoted one',
      {
        code: 'unsafe-path',
        path: 'a'.repeat(PACK_REJECTED_NAME_MAX_LENGTH + 2),
      },
    ],
    ['an unknown size limit', { code: 'too-large', limit: 'depth' }],
    ['an unknown image limit', { code: 'image-too-large', limit: 'height' }],
    [
      'an unknown API reason',
      { code: 'api-incompatible', reason: 'older', required: '1.0' },
    ],
    [
      'a bad required version',
      { code: 'api-incompatible', reason: 'pack-newer', required: '1' },
    ],
    ['an unknown entry problem', { code: 'entry-unparsable', reason: 'x' }],
    [
      'a bad pack id',
      { code: 'root-folder-mismatch', folder: 'a', packId: 'Bad' },
    ],
    [
      `more than ${PACK_IMPORT_REPORTED_ISSUES_MAX} issues`,
      {
        code: 'invalid-manifest',
        issues: Array.from(
          { length: PACK_IMPORT_REPORTED_ISSUES_MAX + 1 },
          () => ({ code: 'custom', path: [] }),
        ),
      },
    ],
    ['no issues list', { code: 'invalid-manifest' }],
  ])('rejects %s', (_label, value) => {
    expectRejected(packRejectionSchema, value);
  });

  it('its output is a PackRejection', () => {
    expectTypeOf<
      ReturnType<typeof packRejectionSchema.parse>
    >().toExtend<PackRejection>();
  });
});

describe('packManifestIssueSchema', () => {
  it.each([
    ['a rule', { code: 'custom', rule: 'duplicate-state', path: ['a', 0] }],
    ['no rule', { code: 'invalid_type', path: [] }],
  ])('round-trips an issue with %s', (_label, value) => {
    expectRoundTrip(packManifestIssueSchema, value);
  });

  it.each([
    ['an unknown rule', { code: 'custom', rule: 'made-up', path: [] }],
    ['an undefined rule', { code: 'custom', rule: undefined, path: [] }],
    ['an empty code', { code: '', path: [] }],
    ['a negative index', { code: 'custom', path: [-1] }],
    [
      'a long segment',
      { code: 'custom', path: ['k'.repeat(PACK_REJECTED_NAME_MAX_LENGTH + 2)] },
    ],
    ['no path', { code: 'custom' }],
  ])('rejects %s', (_label, value) => {
    expectRejected(packManifestIssueSchema, value);
  });
});

describe('stagePackImportSchema', () => {
  const CONFIRM = {
    phase: 'confirm',
    packId: 'sample-pack',
    name: '樣本包',
    version: '1.4.0',
    previous: { name: '樣本包', version: '1.5.0' },
    downgrade: true,
  };
  const INSTALLED = {
    phase: 'result',
    outcome: 'installed',
    packId: 'sample-pack',
    name: '樣本包',
    version: '1.4.0',
  };

  it('starts idle', () => {
    expect(IDLE_PACK_IMPORT).toStrictEqual({ phase: 'idle' });
    expect(Object.isFrozen(IDLE_PACK_IMPORT)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['idle', { phase: 'idle' }],
    ['reading', { phase: 'reading' }],
    ['a confirmation', CONFIRM],
    ['an installed result', INSTALLED],
    [
      'a rejected result',
      {
        phase: 'result',
        outcome: 'rejected',
        rejection: REJECTIONS['missing-file'],
        moreIssues: 0,
      },
    ],
    [
      'an invalid-manifest with more issues',
      {
        phase: 'result',
        outcome: 'rejected',
        rejection: REJECTIONS['invalid-manifest'],
        moreIssues: 12,
      },
    ],
    [
      'a failed result',
      { phase: 'result', outcome: 'failed', code: 'stale-plan' },
    ],
    ['a cancelled result', { phase: 'result', outcome: 'cancelled' }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stagePackImportSchema, value);
  });

  it.each<[string, unknown]>([
    ['an unknown phase', { phase: 'installing' }],
    ['no phase', {}],
    ['reading with a file', { phase: 'reading', file: '/a.awpet' }],
    ['a confirmation with no previous', { ...CONFIRM, previous: null }],
    [
      'a confirmation with no downgrade flag',
      { ...CONFIRM, downgrade: undefined },
    ],
    ['a confirmation with a bad version', { ...CONFIRM, version: 'v1' }],
    ['a result with no outcome', { phase: 'result' }],
    ['an unknown outcome', { phase: 'result', outcome: 'done' }],
    ['an installed result with no name', { ...INSTALLED, name: undefined }],
    [
      'a failed result with an unknown code',
      { phase: 'result', outcome: 'failed', code: 'disk-full' },
    ],
    [
      'a rejected result with no moreIssues',
      {
        phase: 'result',
        outcome: 'rejected',
        rejection: REJECTIONS['missing-file'],
      },
    ],
    [
      'more issues on a rejection that is not invalid-manifest',
      {
        phase: 'result',
        outcome: 'rejected',
        rejection: REJECTIONS['missing-file'],
        moreIssues: 1,
      },
    ],
    [
      'a negative moreIssues',
      {
        phase: 'result',
        outcome: 'rejected',
        rejection: REJECTIONS['invalid-manifest'],
        moreIssues: -1,
      },
    ],
    [
      'a cancelled result with a reason',
      { phase: 'result', outcome: 'cancelled', code: 'stale-plan' },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(stagePackImportSchema, value);
  });
});

describe('packsConfirmInputSchema', () => {
  it.each([[[true]], [[false]]])('takes %j', (args) => {
    expectRoundTrip(packsConfirmInputSchema, args);
  });

  it.each([
    ['nothing', []],
    ['a string', ['true']],
    ['a number', [1]],
    ['two flags', [true, true]],
  ])('rejects %s', (_label, args) => {
    expectRejected(packsConfirmInputSchema, args);
  });
});
