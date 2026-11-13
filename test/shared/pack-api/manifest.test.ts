import { describe, expect, it } from 'vitest';
import {
  assetSchema,
  CHARACTER_HEIGHT_MAX,
  entryPathSchema,
  localBoxSchema,
  localPointSchema,
  MANIFEST_CHARACTERS_MAX,
  manifestSchema,
  type PackApiIssueRule,
  packIdSchema,
  packPathSchema,
  PACK_VERSION_MAX_LENGTH,
  packVersionSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { expectRuleIssue, ruleIssues } from './issues';
import {
  changed,
  MINIMAL_MANIFEST,
  PROBE_A,
  removed,
  SAMPLE_MANIFEST,
  type SamplePath,
  withProtoKey,
} from './samples';

const A = ['characters', 0] as const;
const B = ['characters', 1] as const;

/** SAMPLE_MANIFEST with the value at `path` set to `value`. */
function manifestWith(path: SamplePath, value: unknown): unknown {
  return changed(SAMPLE_MANIFEST, path, value);
}

describe('I/O matrix', () => {
  it('完整 manifest: the two-character sample with every parameter type passes', () => {
    const types = SAMPLE_MANIFEST.characters.flatMap((c) =>
      c.params.map((p) => p.type),
    );
    expect(SAMPLE_MANIFEST.characters).toHaveLength(2);
    expect(new Set(types)).toStrictEqual(
      new Set(['bool', 'int', 'number', 'choice', 'asset']),
    );
    expectRoundTrip(manifestSchema, SAMPLE_MANIFEST);
  });

  it.each<[string, SamplePath, unknown, PackApiIssueRule, SamplePath]>([
    [
      'an asset option',
      [...B, 'params', 3, 'options', 1],
      'body-stripes',
      'missing-asset-option',
      [...B, 'params', 3, 'options', 1],
    ],
    [
      'an asset default (and option)',
      [...B, 'params', 3],
      {
        key: 'skin',
        label: '外觀',
        type: 'asset',
        options: ['body-plain', 'body-stripes'],
        default: 'body-stripes',
      },
      'missing-asset-default',
      [...B, 'params', 3, 'default'],
    ],
    [
      'a projectile',
      ['projectiles', 'zap'],
      'bolt',
      'missing-projectile-asset',
      ['projectiles', 'zap'],
    ],
  ])(
    '參照不存在: %s naming a key not in assets is rejected',
    (_label, path, value, rule, issuePath) => {
      expectRuleIssue(manifestSchema, manifestWith(path, value), rule, [
        ...issuePath,
      ]);
    },
  );

  it('參照不存在: an asset parameter on a manifest with no assets is rejected for its options and default only', () => {
    const manifest = removed(changed(SAMPLE_MANIFEST, ['assets'], {}), [
      'projectiles',
    ]);
    const skin = [...B, 'params', 3];
    expect(ruleIssues(manifestSchema, manifest)).toStrictEqual([
      { rule: 'missing-asset-option', path: [...skin, 'options', 0] },
      { rule: 'missing-asset-option', path: [...skin, 'options', 1] },
      { rule: 'missing-asset-default', path: [...skin, 'default'] },
    ]);
  });

  it.each<[string, SamplePath, unknown, PackApiIssueRule, SamplePath]>([
    [
      'a character id',
      [...B, 'id'],
      'probe-a',
      'duplicate-character-id',
      ['characters', 1, 'id'],
    ],
    [
      'a parameter key within one character',
      [...B, 'params', 1, 'key'],
      'blink-every',
      'duplicate-param-key',
      [...B, 'params', 1, 'key'],
    ],
    [
      'a state',
      [...A, 'states'],
      ['thinking', 'working', 'thinking', 'waiting'],
      'duplicate-state',
      [...A, 'states', 2],
    ],
  ])('重複: %s twice is rejected', (_label, path, value, rule, issuePath) => {
    expectRuleIssue(manifestSchema, manifestWith(path, value), rule, [
      ...issuePath,
    ]);
  });

  it('重複: the same parameter key on two characters is fine', () => {
    expectRoundTrip(
      manifestSchema,
      manifestWith([...B, 'params', 0, 'key'], 'glow'),
    );
  });

  it.each<[string, Record<string, string>, PackApiIssueRule]>([
    [
      'a key that is in states',
      { thinking: 'waiting' },
      'fallback-key-in-states',
    ],
    [
      'a value that is not in states',
      { done: 'error' },
      'fallback-value-not-in-states',
    ],
    [
      'a value that is another missing state',
      { done: 'idle' },
      'fallback-value-not-in-states',
    ],
  ])('fallback: %s is rejected', (_label, fallback, rule) => {
    const [key] = Object.keys(fallback);
    expectRuleIssue(
      manifestSchema,
      manifestWith([...A, 'fallback'], fallback),
      rule,
      [...A, 'fallback', key],
    );
  });

  it.each([
    ['an unknown state as a key', { sleeping: 'waiting' }],
    ['an unknown state as a value', { done: 'sleeping' }],
    ['a list', ['waiting']],
  ])('fallback: %s is rejected', (_label, fallback) => {
    expectRejected(manifestSchema, manifestWith([...A, 'fallback'], fallback));
  });

  it.each([
    ['inPool', { inPool: false }],
    ['badges', { badges: true }],
    ['an unknown field', { scale: 1, speed: 'fast' }],
  ])('defaults: a character default for %s is rejected', (_label, defaults) => {
    expectRejected(manifestSchema, manifestWith([...B, 'defaults'], defaults));
  });

  it('defaults: scale and part of wander are accepted', () => {
    expectRoundTrip(
      manifestSchema,
      manifestWith([...A, 'defaults'], {
        scale: 2,
        wander: { enabled: false },
      }),
    );
  });
});

describe('manifestSchema', () => {
  it.each([
    ['the minimal manifest', MINIMAL_MANIFEST],
    [
      'the most characters',
      changed(
        MINIMAL_MANIFEST,
        ['characters'],
        Array.from({ length: MANIFEST_CHARACTERS_MAX }, (_, i) => ({
          ...MINIMAL_MANIFEST.characters[0],
          id: `c${i}`,
        })),
      ),
    ],
    [
      'the tallest character',
      changed(
        MINIMAL_MANIFEST,
        ['characters', 0, 'height'],
        CHARACTER_HEIGHT_MAX,
      ),
    ],
    ['an empty fallback', manifestWith([...A, 'fallback'], {})],
    ['no projectiles', removed(SAMPLE_MANIFEST, ['projectiles'])],
    ['no fallback', removed(SAMPLE_MANIFEST, [...A, 'fallback'])],
    ['advancedBitmap false', manifestWith([...A, 'advancedBitmap'], false)],
    [
      'an asset used only as a projectile',
      manifestWith(['projectiles', 'zap'], 'sheet'),
    ],
    [
      'negative and fractional coordinates',
      manifestWith([...A, 'anchor'], { x: -0.5, y: -130.25 }),
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(manifestSchema, value);
  });

  it.each<[string, unknown]>([
    ['no characters', changed(SAMPLE_MANIFEST, ['characters'], [])],
    [
      'too many characters',
      changed(
        MINIMAL_MANIFEST,
        ['characters'],
        Array.from({ length: MANIFEST_CHARACTERS_MAX + 1 }, (_, i) => ({
          ...MINIMAL_MANIFEST.characters[0],
          id: `c${i}`,
        })),
      ),
    ],
    ['a bad pack id', manifestWith(['id'], 'Sample')],
    ['an empty name', manifestWith(['name'], '')],
    ['a 65-character name', manifestWith(['name'], 'x'.repeat(65))],
    ['a bad version', manifestWith(['version'], '1.4')],
    ['a bad apiVersion', manifestWith(['apiVersion'], '1')],
    ['an entry that is not .js', manifestWith(['entry'], 'dist/entry.mjs')],
    ['an unknown top-level field', manifestWith(['author'], 'x')],
    ['no entry', removed(SAMPLE_MANIFEST, ['entry'])],
    ['no assets', removed(SAMPLE_MANIFEST, ['assets'])],
    [
      'a bad asset key',
      manifestWith(['assets', 'Body'], { kind: 'image', path: 'a.png' }),
    ],
    ['a bad asset', manifestWith(['assets', 'spark', 'kind'], 'sound')],
    ['a bad projectile id', manifestWith(['projectiles', 'Zap'], 'spark')],
    ['a projectile set to undefined', manifestWith(['projectiles'], undefined)],
    ['a bad character id', manifestWith([...A, 'id'], 'Probe')],
    ['an empty character name', manifestWith([...A, 'name'], '')],
    ['a height of 0', manifestWith([...A, 'height'], 0)],
    [
      'a height above the most',
      manifestWith([...A, 'height'], CHARACTER_HEIGHT_MAX + 1),
    ],
    ['an infinite height', manifestWith([...A, 'height'], Infinity)],
    ['no states', manifestWith([...A, 'states'], [])],
    ['an unknown state', manifestWith([...A, 'states'], ['sleeping'])],
    ['no params list', removed(SAMPLE_MANIFEST, [...A, 'params'])],
    ['a bad parameter', manifestWith([...A, 'params', 0, 'type'], 'color')],
    ['no hitbox', removed(SAMPLE_MANIFEST, [...A, 'hitbox'])],
    ['a hitbox of width 0', manifestWith([...A, 'hitbox', 'width'], 0)],
    ['bounds of negative height', manifestWith([...A, 'bounds', 'height'], -1)],
    ['an infinite anchor', manifestWith([...A, 'anchor', 'y'], -Infinity)],
    ['an anchor with an extra field', manifestWith([...A, 'anchor', 'z'], 0)],
    [
      'advancedBitmap as a string',
      manifestWith([...A, 'advancedBitmap'], 'yes'),
    ],
    ['an unknown character field', manifestWith([...A, 'color'], 'red')],
    ['a list', [SAMPLE_MANIFEST]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(manifestSchema, value);
  });

  it('names each repeat and missing reference by its rule and path', () => {
    const manifest = changed(
      changed(
        changed(SAMPLE_MANIFEST, ['characters', 2], PROBE_A),
        ['projectiles', 'zap'],
        'bolt',
      ),
      [...A, 'fallback', 'done'],
      'error',
    );
    expect(ruleIssues(manifestSchema, manifest)).toStrictEqual([
      { rule: 'duplicate-character-id', path: ['characters', 2, 'id'] },
      {
        rule: 'fallback-value-not-in-states',
        path: [...A, 'fallback', 'done'],
      },
      { rule: 'missing-projectile-asset', path: ['projectiles', 'zap'] },
    ]);
  });

  it.each<[string, SamplePath, unknown]>([
    ['assets', ['assets'], { kind: 'image', path: 'img/x.png' }],
    ['projectiles', ['projectiles'], 'spark'],
    ['a fallback', [...A, 'fallback'], 'waiting'],
  ])(
    'rejects %s with a __proto__ key as reserved-key',
    (_label, path, value) => {
      let record: unknown = SAMPLE_MANIFEST;
      for (const step of path) {
        record = (record as Record<string | number, unknown>)[step];
      }
      const manifest = manifestWith(
        path,
        withProtoKey(record as object, value),
      );
      expectRuleIssue(manifestSchema, manifest, 'reserved-key', [...path]);
    },
  );

  it.each([
    ['equal to the bounds', { x: -60, y: -140, width: 120, height: 140 }],
    ['touching the left edge', { x: -60, y: -110, width: 60, height: 110 }],
  ])('accepts a hitbox %s', (_label, hitbox) => {
    expectRoundTrip(manifestSchema, manifestWith([...A, 'hitbox'], hitbox));
  });

  it.each([
    ['past the left edge', { x: -61, y: -110, width: 60, height: 110 }],
    ['past the right edge', { x: 1, y: -110, width: 60, height: 110 }],
    ['past the top', { x: -30, y: -141, width: 60, height: 110 }],
    ['below the feet', { x: -30, y: -110, width: 60, height: 111 }],
    ['wholly outside', { x: 100, y: 100, width: 1, height: 1 }],
  ])('rejects a hitbox %s of the bounds', (_label, hitbox) => {
    expectRuleIssue(
      manifestSchema,
      manifestWith([...A, 'hitbox'], hitbox),
      'hitbox-outside-bounds',
      [...A, 'hitbox'],
    );
  });

  it.each<[string, SamplePath]>([
    ['a pack name', ['name']],
    ['a character name', [...A, 'name']],
  ])('rejects %s of only white space as blank-label', (_label, path) => {
    for (const blank of ['  ', '\u3000', '\t']) {
      expectRuleIssue(
        manifestSchema,
        manifestWith(path, blank),
        'blank-label',
        [...path],
      );
    }
  });

  it.each([
    ['all digits', '123', 'pack-id-all-digits'],
    ['0x', '0x', 'pack-id-hex-prefix'],
    ['a 0x prefix', '0x1f', 'pack-id-hex-prefix'],
    ['con', 'con', 'pack-id-device-name'],
  ] as const)('rejects a pack id that is %s as %s', (_label, id, rule) => {
    expectRuleIssue(manifestSchema, manifestWith(['id'], id), rule, ['id']);
  });

  it('allows the ids a pack id may not be on characters and asset keys', () => {
    const manifest = changed(
      changed(
        changed(SAMPLE_MANIFEST, [...A, 'id'], '123'),
        [...B, 'id'],
        'con',
      ),
      ['assets', '0x1f'],
      { kind: 'image', path: 'img/x.png' },
    );
    expectRoundTrip(manifestSchema, manifest);
  });
});

describe('packIdSchema', () => {
  it.each([
    'ab',
    'a1',
    '1a',
    '1-2',
    'x0',
    '0y',
    'com0',
    'com10',
    'con1',
    'lpt',
  ])('accepts %s', (id) => {
    expectRoundTrip(packIdSchema, id);
  });

  it.each<[string, PackApiIssueRule]>([
    ['00', 'pack-id-all-digits'],
    ['123', 'pack-id-all-digits'],
    ['1'.repeat(64), 'pack-id-all-digits'],
    ['0x', 'pack-id-hex-prefix'],
    ['0x1', 'pack-id-hex-prefix'],
    ['0xzz', 'pack-id-hex-prefix'],
    ['0x-a', 'pack-id-hex-prefix'],
    ['con', 'pack-id-device-name'],
    ['prn', 'pack-id-device-name'],
    ['aux', 'pack-id-device-name'],
    ['nul', 'pack-id-device-name'],
    ['com1', 'pack-id-device-name'],
    ['com9', 'pack-id-device-name'],
    ['lpt1', 'pack-id-device-name'],
    ['lpt9', 'pack-id-device-name'],
  ])('rejects %s as %s', (id, rule) => {
    expectRuleIssue(packIdSchema, id, rule, []);
  });

  it.each([
    ['not an id', 'Con'],
    ['one character', '0'],
    ['empty', ''],
  ])('rejects %s', (_label, id) => {
    expectRejected(packIdSchema, id);
  });
});

describe('packVersionSchema', () => {
  it.each(['0.0.0', '1.4.0', '10.20.300', '2026.11.13'])(
    'round-trips %s',
    (version) => {
      expectRoundTrip(packVersionSchema, version);
    },
  );

  it('takes up to PACK_VERSION_MAX_LENGTH (32) characters', () => {
    expect(PACK_VERSION_MAX_LENGTH).toBe(32);
    const longest = `1.0.${'9'.repeat(PACK_VERSION_MAX_LENGTH - 4)}`;
    expect(longest).toHaveLength(32);
    expectRoundTrip(packVersionSchema, longest);
    expectRejected(packVersionSchema, `${longest}9`);
    expectRejected(packVersionSchema, `1.0.${'9'.repeat(400)}`);
  });

  it.each([
    ['two parts', '1.4'],
    ['four parts', '1.4.0.0'],
    ['a prerelease', '1.4.0-beta.1'],
    ['build metadata', '1.4.0+abc'],
    ['a leading zero', '01.4.0'],
    ['a leading v', 'v1.4.0'],
    ['a slash', '1/4/0'],
    ['empty', ''],
    ['a number', 1.4],
  ])('rejects %s', (_label, version) => {
    expectRejected(packVersionSchema, version);
  });
});

describe('pack paths', () => {
  it.each([
    'a.png',
    'img/sheet.json',
    'img/a.b/c.png',
    'x',
    'Img/A_b-C.PNG',
    'img/a..png',
    '.hidden/a.png',
    '.hidden.png',
    'img/.a.b-c_d',
  ])('a pack path may be %s', (path) => {
    expectRoundTrip(packPathSchema, path);
  });

  it.each([
    ['empty', ''],
    ['a leading /', '/img/a.png'],
    ['a trailing /', 'img/'],
    ['a .. segment', 'img/../a.png'],
    ['a leading ..', '../a.png'],
    ['a drive letter', 'C:/x.js'],
    ['a backslash', 'img\\a.png'],
    ['a leading ./', './a.js'],
    ['a doubled /', 'a//b.js'],
    ['a . segment', 'a/./b.js'],
    ['a name ending in .', 'a.'],
    ['a name of only dots', '...'],
    ['a folder ending in .', 'img/a./b.png'],
    ['a NUL', 'a\0.png'],
    ['a control character', 'a\n.png'],
    ['a #', 'a#b.png'],
    ['a ?', 'a?b.png'],
    ['a %', 'a%2e.png'],
    ['a space', 'a b.png'],
    ['a non-ASCII letter', '圖/a.png'],
  ])('a pack path may not have %s', (_label, path) => {
    expectRuleIssue(packPathSchema, path, 'invalid-pack-path', []);
  });

  it('a pack path is a string', () => {
    expectRejected(packPathSchema, 1);
  });

  it.each(['entry.js', 'dist/entry.js', 'a/b/c.min.js'])(
    'an entry may be %s',
    (path) => {
      expectRoundTrip(entryPathSchema, path);
    },
  );

  it.each([
    ['not .js', 'entry.mjs'],
    ['no extension', 'entry'],
    ['.js in the middle', 'entry.js.map'],
  ])('an entry may not be %s', (_label, path) => {
    expectRuleIssue(entryPathSchema, path, 'entry-not-js', []);
  });

  it.each([
    ['a leading /', '/entry.js'],
    ['a .. segment', '../entry.js'],
    ['a drive letter', 'C:/x.js'],
  ])('an entry may not have %s', (_label, path) => {
    expectRuleIssue(entryPathSchema, path, 'invalid-pack-path', []);
  });
});

describe('assetSchema', () => {
  it.each([
    { kind: 'image', path: 'img/a.png' },
    { kind: 'spritesheet', path: 'img/a.json' },
  ])('round-trips %o', (value) => {
    expectRoundTrip(assetSchema, value);
  });

  it.each([
    ['an unknown kind', { kind: 'sound', path: 'a.wav' }],
    ['a bad path', { kind: 'image', path: '../a.png' }],
    ['no path', { kind: 'image' }],
    ['an extra field', { kind: 'image', path: 'a.png', width: 10 }],
  ])('rejects %s', (_label, value) => {
    expectRejected(assetSchema, value);
  });
});

describe('local geometry', () => {
  it('round-trips a box and a point', () => {
    expectRoundTrip(localBoxSchema, { x: -1.5, y: -2, width: 0.5, height: 3 });
    expectRoundTrip(localPointSchema, { x: 0, y: -120 });
  });

  it.each([
    ['width 0', { x: 0, y: 0, width: 0, height: 1 }],
    ['negative height', { x: 0, y: 0, width: 1, height: -1 }],
    ['an infinite x', { x: Infinity, y: 0, width: 1, height: 1 }],
    ['NaN y', { x: 0, y: Number.NaN, width: 1, height: 1 }],
    ['no height', { x: 0, y: 0, width: 1 }],
    ['an extra field', { x: 0, y: 0, width: 1, height: 1, r: 0 }],
  ])('a box rejects %s', (_label, value) => {
    expectRejected(localBoxSchema, value);
  });

  it.each([
    ['no y', { x: 0 }],
    ['an infinite y', { x: 0, y: Infinity }],
    ['an extra field', { x: 0, y: 0, z: 0 }],
  ])('a point rejects %s', (_label, value) => {
    expectRejected(localPointSchema, value);
  });
});
