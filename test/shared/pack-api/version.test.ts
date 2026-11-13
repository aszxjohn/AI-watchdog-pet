import { describe, expect, it } from 'vitest';
import {
  API_INCOMPATIBILITY_REASONS,
  apiVersionSchema,
  checkApiCompatibility,
  formatApiVersion,
  manifestApiVersionSchema,
  manifestSchema,
  PACK_API_VERSION,
  parseApiVersion,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { changed, SAMPLE_MANIFEST } from './samples';

describe('I/O matrix', () => {
  it('相容: a 1.0 pack on a 1.0 stage is compatible', () => {
    expect(checkApiCompatibility('1.0', { major: 1, minor: 0 })).toStrictEqual({
      compatible: true,
    });
  });

  it('包較新: a 1.2 pack on a 1.0 stage is not, being newer, and needs 1.2', () => {
    expect(checkApiCompatibility('1.2', { major: 1, minor: 0 })).toStrictEqual({
      compatible: false,
      reason: 'pack-newer',
      required: '1.2',
    });
  });

  it.each(['2.0', '0.9'])(
    '主版不同: a %s pack on a 1.0 stage is not compatible, its major differing',
    (version) => {
      expect(
        checkApiCompatibility(version, { major: 1, minor: 0 }),
      ).toStrictEqual({
        compatible: false,
        reason: 'major-mismatch',
        required: version,
      });
    },
  );

  it('版本先檢查: the lenient schema takes 1.3 from a manifest with an unknown field, which the full schema rejects', () => {
    const manifest = changed(
      changed(SAMPLE_MANIFEST, ['apiVersion'], '1.3'),
      ['sounds'],
      { beep: 'a.wav' },
    );

    const lenient = manifestApiVersionSchema.safeParse(manifest);
    expect(lenient.success).toBe(true);
    expect(lenient.data).toStrictEqual({ apiVersion: '1.3' });
    expect(checkApiCompatibility(lenient.data?.apiVersion ?? '')).toStrictEqual(
      { compatible: false, reason: 'pack-newer', required: '1.3' },
    );
    expectRejected(manifestSchema, manifest);
  });
});

describe('PACK_API_VERSION', () => {
  it('is 1.0 and cannot be changed', () => {
    expect(PACK_API_VERSION).toStrictEqual({ major: 1, minor: 0 });
    expect(Object.isFrozen(PACK_API_VERSION)).toBe(true);
    expect(formatApiVersion(PACK_API_VERSION)).toBe('1.0');
  });

  it('is what the check compares with when no stage version is given', () => {
    expect(checkApiCompatibility('1.0')).toStrictEqual({ compatible: true });
    expect(checkApiCompatibility('1.1')).toStrictEqual({
      compatible: false,
      reason: 'pack-newer',
      required: '1.1',
    });
  });
});

describe('apiVersionSchema', () => {
  it.each(['1.0', '0.9', '12.34', '999.999', '1.00'])(
    'round-trips %s',
    (version) => {
      expectRoundTrip(apiVersionSchema, version);
    },
  );

  it.each([
    ['no minor', '1'],
    ['a patch part', '1.0.0'],
    ['four digits', '1000.0'],
    ['an empty major', '.1'],
    ['an empty minor', '1.'],
    ['a leading v', 'v1.0'],
    ['a sign', '-1.0'],
    ['spaces', ' 1.0'],
    ['a trailing newline', '1.0\n'],
    ['a number', 1.0],
    ['empty', ''],
  ])('rejects %s', (_label, version) => {
    expectRejected(apiVersionSchema, version);
  });
});

describe('parseApiVersion and formatApiVersion', () => {
  it.each([
    ['1.0', { major: 1, minor: 0 }, '1.0'],
    ['12.345', { major: 12, minor: 345 }, '12.345'],
    ['01.020', { major: 1, minor: 20 }, '1.20'],
  ])('%s is %o, written back as %s', (version, parts, written) => {
    expect(parseApiVersion(version)).toStrictEqual(parts);
    expect(formatApiVersion(parts)).toBe(written);
  });

  it('throws on a string that is not an API version', () => {
    expect(() => parseApiVersion('1.0.0')).toThrow(TypeError);
  });
});

describe('checkApiCompatibility', () => {
  const stage = { major: 1, minor: 3 };

  it.each(['1.0', '1.1', '1.3', '01.03'])(
    'a %s pack runs on a 1.3 stage',
    (version) => {
      expect(checkApiCompatibility(version, stage)).toStrictEqual({
        compatible: true,
      });
    },
  );

  it('has two reasons for not running', () => {
    expect([...API_INCOMPATIBILITY_REASONS]).toStrictEqual([
      'pack-newer',
      'major-mismatch',
    ]);
  });

  it.each([
    ['1.4', 'pack-newer', '1.4'],
    ['1.10', 'pack-newer', '1.10'],
    ['01.004', 'pack-newer', '1.4'],
    ['0.3', 'major-mismatch', '0.3'],
    ['0.9', 'major-mismatch', '0.9'],
    ['2.3', 'major-mismatch', '2.3'],
    ['2.0', 'major-mismatch', '2.0'],
  ])('a %s pack does not (%s), and needs %s', (version, reason, required) => {
    expect(checkApiCompatibility(version, stage)).toStrictEqual({
      compatible: false,
      reason,
      required,
    });
  });
});

describe('manifestApiVersionSchema', () => {
  it('takes apiVersion and nothing else', () => {
    expect(manifestApiVersionSchema.parse(SAMPLE_MANIFEST)).toStrictEqual({
      apiVersion: '1.0',
    });
  });

  it.each([
    ['no apiVersion', { id: 'ab' }],
    ['a bad apiVersion', { apiVersion: '1' }],
    ['a number', { apiVersion: 1 }],
    ['a list', [{ apiVersion: '1.0' }]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(manifestApiVersionSchema, value);
  });
});
