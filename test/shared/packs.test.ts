import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PACK_ENTRY_PROBLEMS,
  PACK_IMAGE_LIMITS,
  PACK_INSTALL_FAILURE_CODES,
  PACK_REJECTION_CODES,
  PACK_SIZE_LIMITS,
  packCharacterSummarySchema,
  packIndexEntrySchema,
  packIndexFileSchema,
  PACKS_SCHEMA_VERSION,
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
