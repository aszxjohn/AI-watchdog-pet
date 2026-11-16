import { describe, expect, it } from 'vitest';
import {
  FIXED_OVERRIDES_MAX_ENTRIES,
  PACK_ENABLED_MAX_ENTRIES,
} from '../../src/shared/constants';
import { FIXED_PARAM_DEFAULTS } from '../../src/shared/pack-api';
import {
  isInPool,
  isPackEnabled,
  PACK_ENABLED_DEFAULT,
  SETTINGS_DEFAULTS,
  SETTINGS_FIELDS,
  SETTINGS_KEYED_FIELDS,
  SETTINGS_PATCH_MAX_OPS,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SET_FIELDS,
  settingsFieldSchemas,
  settingsFileSchema,
  settingsOpSchema,
  settingsPatchResultSchema,
  settingsPatchSchema,
  settingsRevSchema,
  settingsStateSchema,
  settingsValuesSchema,
  type DetectionTimings,
} from '../../src/shared/settings';
import { expectRejected, expectRoundTrip } from './schema-helpers';

const DISPLAY_ID = 69733632;

function setDisplay(value: unknown) {
  return { op: 'set', field: 'canvasDisplayId', value };
}

describe('settings fields', () => {
  it('lists exactly the fields that have a schema, in order', () => {
    expect([...SETTINGS_FIELDS]).toStrictEqual([
      'canvasDisplayId',
      'doneMs',
      'idleMs',
      'errorHoldMs',
      'approvalInferMs',
      'sessionExpireMs',
      'discoveryWindowMs',
      'syncTimeoutMs',
      'packEnabled',
      'fixedOverrides',
    ]);
    expect(Object.keys(settingsFieldSchemas)).toStrictEqual([
      ...SETTINGS_FIELDS,
    ]);
    expect(Object.isFrozen(SETTINGS_FIELDS)).toBe(true);
  });

  it('defaults cover every field, pass the schema and cannot be changed', () => {
    expect(Object.keys(SETTINGS_DEFAULTS)).toStrictEqual([...SETTINGS_FIELDS]);
    expectRoundTrip(settingsValuesSchema, SETTINGS_DEFAULTS);
    expect(SETTINGS_DEFAULTS).toStrictEqual({
      canvasDisplayId: null,
      doneMs: 5000,
      idleMs: 300_000,
      errorHoldMs: 30_000,
      approvalInferMs: 10_000,
      sessionExpireMs: 7_200_000,
      discoveryWindowMs: 7_200_000,
      syncTimeoutMs: 10_000,
      packEnabled: {},
      fixedOverrides: {},
    });
    expect(Object.isFrozen(SETTINGS_DEFAULTS)).toBe(true);
  });

  it('the defaults are detection timings as they are', () => {
    const timings: DetectionTimings = SETTINGS_DEFAULTS;
    expect(timings.doneMs).toBe(5000);
    expect(timings.approvalInferMs).toBe(10_000);
  });

  it('starts at schemaVersion 1', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });
});

describe('canvasDisplayId schema', () => {
  const schema = settingsFieldSchemas.canvasDisplayId;

  it.each([[null], [0], [1], [DISPLAY_ID], [Number.MAX_SAFE_INTEGER]])(
    'round-trips %j',
    (value) => {
      expectRoundTrip(schema, value);
    },
  );

  it.each([
    ['a negative id', -1],
    ['a fraction', 1.5],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1'],
    ['undefined', undefined],
    ['an object', { id: 1 }],
  ])('rejects %s', (_label, value) => {
    expectRejected(schema, value);
  });
});

/** Each detection timing: its schema's range and its default (Story 2.2). */
const TIMINGS = [
  ['doneMs', 1000, 60_000, 5000],
  ['idleMs', 60_000, 3_600_000, 300_000],
  ['errorHoldMs', 1000, 600_000, 30_000],
  ['approvalInferMs', 1000, 600_000, 10_000],
  ['sessionExpireMs', 3_660_000, 86_400_000, 7_200_000],
  ['discoveryWindowMs', 600_000, 86_400_000, 7_200_000],
  ['syncTimeoutMs', 1000, 60_000, 10_000],
] as const;

describe.each(TIMINGS)('%s schema', (field, min, max, fallback) => {
  const schema = settingsFieldSchemas[field];

  it(`defaults to ${fallback}`, () => {
    expect(SETTINGS_DEFAULTS[field]).toBe(fallback);
  });

  it.each([[min], [min + 1], [fallback], [max - 1], [max]])(
    'round-trips %j',
    (value) => {
      expectRoundTrip(schema, value);
    },
  );

  it.each([
    ['one below the minimum', min - 1],
    ['one above the maximum', max + 1],
    ['zero', 0],
    ['a negative number', -fallback],
    ['a fraction', fallback + 0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', String(fallback)],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expectRejected(schema, value);
  });

  it('is set by a patch op within its range only', () => {
    expectRoundTrip(settingsOpSchema, { op: 'set', field, value: max });
    expectRejected(settingsOpSchema, { op: 'set', field, value: max + 1 });
    expectRejected(settingsOpSchema, { op: 'set', field, value: null });
  });
});

describe('timing ranges', () => {
  it('idleMs can never reach sessionExpireMs: a session shows idle before it expires', () => {
    const idleMax = settingsFieldSchemas.idleMs.maxValue;
    const expireMin = settingsFieldSchemas.sessionExpireMs.minValue;
    expect(idleMax).toBe(3_600_000);
    expect(expireMin).toBe(3_660_000);
    expect(idleMax!).toBeLessThan(expireMin!);
  });

  it('rejects sessionExpireMs of 60 minutes, the most idleMs can be', () => {
    expectRejected(settingsFieldSchemas.sessionExpireMs, 3_600_000);
    expectRoundTrip(settingsFieldSchemas.idleMs, 3_600_000);
  });
});

describe('settingsValuesSchema', () => {
  it('round-trips a complete set of values', () => {
    expectRoundTrip(settingsValuesSchema, {
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: DISPLAY_ID,
    });
  });

  it.each([
    ['a missing field', {}],
    ['only canvasDisplayId', { canvasDisplayId: null }],
    ['an unknown field', { ...SETTINGS_DEFAULTS, theme: 'dark' }],
    [
      'a field of the wrong type',
      { ...SETTINGS_DEFAULTS, canvasDisplayId: 'main' },
    ],
    ['a timing out of range', { ...SETTINGS_DEFAULTS, idleMs: 59_999 }],
    ['schemaVersion (file only)', { schemaVersion: 1, ...SETTINGS_DEFAULTS }],
    ['an array', [null]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsValuesSchema, value);
  });
});

describe('settingsFileSchema', () => {
  it('round-trips the file main writes', () => {
    expectRoundTrip(settingsFileSchema, {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      ...SETTINGS_DEFAULTS,
    });
  });

  it.each([
    ['no schemaVersion', { ...SETTINGS_DEFAULTS }],
    ['another schemaVersion', { schemaVersion: 2, ...SETTINGS_DEFAULTS }],
    ['a missing field', { schemaVersion: 1 }],
    ['an unknown field', { schemaVersion: 1, ...SETTINGS_DEFAULTS, x: 1 }],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsFileSchema, value);
  });
});

describe('settingsStateSchema', () => {
  it('round-trips a rev with its values', () => {
    expectRoundTrip(settingsStateSchema, {
      rev: 4,
      values: { ...SETTINGS_DEFAULTS, canvasDisplayId: DISPLAY_ID },
    });
  });

  it.each([
    ['a negative rev', { rev: -1, values: SETTINGS_DEFAULTS }],
    ['a fractional rev', { rev: 0.5, values: SETTINGS_DEFAULTS }],
    ['no values', { rev: 0 }],
    [
      'bad values',
      { rev: 0, values: { ...SETTINGS_DEFAULTS, canvasDisplayId: -1 } },
    ],
    ['an extra key', { rev: 0, values: SETTINGS_DEFAULTS, merged: false }],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsStateSchema, value);
  });

  it('rev starts at 0 and is a non-negative integer', () => {
    expectRoundTrip(settingsRevSchema, 0);
    expectRejected(settingsRevSchema, -1);
  });
});

describe('settingsOpSchema', () => {
  it.each([[null], [DISPLAY_ID]])('round-trips a set of %j', (value) => {
    expectRoundTrip(settingsOpSchema, setDisplay(value));
  });

  it.each([
    ['an unknown field', { op: 'set', field: 'theme', value: 'dark' }],
    ['a value of the wrong type', setDisplay('main')],
    ['a value the field rejects', setDisplay(-5)],
    ['a missing value', { op: 'set', field: 'canvasDisplayId' }],
    ['an unknown op', { op: 'reset', field: 'canvasDisplayId', value: null }],
    ['no op', { field: 'canvasDisplayId', value: null }],
    ['an extra key', { ...setDisplay(null), at: 1 }],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsOpSchema, value);
  });
});

describe('settingsPatchSchema', () => {
  it('round-trips the design-notes example', () => {
    expectRoundTrip(settingsPatchSchema, {
      baseRev: 3,
      ops: [setDisplay(DISPLAY_ID)],
    });
  });

  it(`accepts up to ${SETTINGS_PATCH_MAX_OPS} ops`, () => {
    expect(SETTINGS_PATCH_MAX_OPS).toBe(64);
    expectRoundTrip(settingsPatchSchema, {
      baseRev: 0,
      ops: Array.from({ length: SETTINGS_PATCH_MAX_OPS }, (_, i) =>
        setDisplay(i),
      ),
    });
  });

  it.each([
    ['no ops', { baseRev: 0, ops: [] }],
    [
      'too many ops',
      {
        baseRev: 0,
        ops: Array.from({ length: SETTINGS_PATCH_MAX_OPS + 1 }, () =>
          setDisplay(null),
        ),
      },
    ],
    ['an unknown field', { baseRev: 0, ops: [{ op: 'set', field: 'x' }] }],
    ['a bad value', { baseRev: 0, ops: [setDisplay(true)] }],
    ['no baseRev', { ops: [setDisplay(null)] }],
    ['a negative baseRev', { baseRev: -1, ops: [setDisplay(null)] }],
    ['a string baseRev', { baseRev: '0', ops: [setDisplay(null)] }],
    [
      'a whole-settings overwrite',
      { baseRev: 0, values: { canvasDisplayId: null } },
    ],
    ['an extra key', { baseRev: 0, ops: [setDisplay(null)], force: true }],
    ['ops that are not an array', { baseRev: 0, ops: setDisplay(null) }],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsPatchSchema, value);
  });
});

describe('settingsPatchResultSchema', () => {
  it.each([
    [{ rev: 0, merged: false, saved: true }],
    [{ rev: 8, merged: true, saved: true }],
    [{ rev: 2, merged: false, saved: false }],
  ])('round-trips %j', (value) => {
    expectRoundTrip(settingsPatchResultSchema, value);
  });

  it.each([
    ['no merged', { rev: 1, saved: true }],
    ['merged as a string', { rev: 1, merged: 'false', saved: true }],
    ['a negative rev', { rev: -1, merged: false, saved: true }],
    ['an extra key', { rev: 1, merged: false, saved: true, values: {} }],
    ['no saved', { rev: 1, merged: false }],
    ['saved as a string', { rev: 1, merged: false, saved: 'true' }],
    ['saved null', { rev: 1, merged: false, saved: null }],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsPatchResultSchema, value);
  });
});

/** `count` distinct pack ids: `pack-0`, `pack-1`, … */
function packIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `pack-${i}`);
}

/** An object whose own key `__proto__` is set, as JSON.parse makes it. */
function withProtoKey(value: unknown): unknown {
  return JSON.parse(`{"__proto__": ${JSON.stringify(value)}}`);
}

describe('the keyed settings (Story 3.3)', () => {
  it('are packEnabled and fixedOverrides, defaulting to empty, and no set op covers them', () => {
    expect([...SETTINGS_KEYED_FIELDS]).toStrictEqual([
      'packEnabled',
      'fixedOverrides',
    ]);
    expect([...SETTINGS_SET_FIELDS]).toStrictEqual(
      SETTINGS_FIELDS.filter(
        (field) => field !== 'packEnabled' && field !== 'fixedOverrides',
      ),
    );
    expect(Object.isFrozen(SETTINGS_SET_FIELDS)).toBe(true);
    expect(SETTINGS_DEFAULTS.packEnabled).toStrictEqual({});
    expect(SETTINGS_DEFAULTS.fixedOverrides).toStrictEqual({});
    expect(Object.isFrozen(SETTINGS_DEFAULTS.packEnabled)).toBe(true);
    expect(Object.isFrozen(SETTINGS_DEFAULTS.fixedOverrides)).toBe(true);
  });

  it('keep at most 1024 上場 values and 4096 characters of fixed parameters', () => {
    expect(PACK_ENABLED_MAX_ENTRIES).toBe(1024);
    expect(FIXED_OVERRIDES_MAX_ENTRIES).toBe(4096);
  });

  it('default to 上場 and 加入池子 on', () => {
    expect(PACK_ENABLED_DEFAULT).toBe(true);
    expect(FIXED_PARAM_DEFAULTS.inPool).toBe(true);
  });
});

describe('packEnabled schema', () => {
  const schema = settingsFieldSchemas.packEnabled;

  it.each([
    ['empty', {}],
    ['one pack off', { 'pack-a': false }],
    ['a value equal to the default', { 'pack-a': true }],
    ['a pack id named like an Object key', { constructor: false }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(schema, value);
  });

  it(`accepts exactly ${PACK_ENABLED_MAX_ENTRIES} entries and rejects one more`, () => {
    const full = Object.fromEntries(
      packIds(PACK_ENABLED_MAX_ENTRIES).map((id) => [id, false]),
    );
    expectRoundTrip(schema, full);
    expectRejected(schema, { ...full, 'one-more': false });
  });

  it.each([
    ['an upper-case key', { 'Pack-A': false }],
    ['an all-digit pack id', { '123': false }],
    ['a pack id starting with 0x', { '0xab': false }],
    ['a Windows device name', { con: false }],
    ['a character key', { 'pack-a/char-a': false }],
    ['an empty key', { '': false }],
    ['a string value', { 'pack-a': 'false' }],
    ['a null value', { 'pack-a': null }],
    ['a number value', { 'pack-a': 0 }],
    ['an own __proto__ key', withProtoKey(false)],
    ['an array', [false]],
    ['null', null],
    ['a boolean', false],
  ])('rejects %s', (_label, value) => {
    expectRejected(schema, value);
  });
});

describe('fixedOverrides schema', () => {
  const schema = settingsFieldSchemas.fixedOverrides;

  it.each([
    ['empty', {}],
    ['one character out of the pool', { 'pack-a/char-a': { inPool: false } }],
    ['an entry with nothing in it', { 'pack-a/char-a': {} }],
    [
      'the same character id in two packs',
      {
        'pack-a/char-a': { inPool: false },
        'pack-b/char-a': { inPool: true },
      },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(schema, value);
  });

  it(`accepts exactly ${FIXED_OVERRIDES_MAX_ENTRIES} characters and rejects one more`, () => {
    const full = Object.fromEntries(
      Array.from({ length: FIXED_OVERRIDES_MAX_ENTRIES }, (_, i) => [
        `pack-${i % 64}/char-${i}`,
        { inPool: false },
      ]),
    );
    expectRoundTrip(schema, full);
    expectRejected(schema, { ...full, 'pack-a/one-more': { inPool: false } });
  });

  it.each([
    ['a pack id alone', { 'pack-a': { inPool: false } }],
    ['no character id', { 'pack-a/': { inPool: false } }],
    ['no pack id', { '/char-a': { inPool: false } }],
    ['three parts', { 'pack-a/char-a/x': { inPool: false } }],
    ['an all-digit pack id', { '123/char-a': { inPool: false } }],
    ['an upper-case character id', { 'pack-a/Char-a': { inPool: false } }],
    ['a parameter not kept yet', { 'pack-a/char-a': { scale: 1.5 } }],
    ['an unknown parameter', { 'pack-a/char-a': { colour: 'red' } }],
    ['a string inPool', { 'pack-a/char-a': { inPool: 'no' } }],
    ['a boolean entry', { 'pack-a/char-a': false }],
    ['an own __proto__ key', withProtoKey({ inPool: false })],
    ['an array', [{ inPool: false }]],
  ])('rejects %s', (_label, value) => {
    expectRejected(schema, value);
  });
});

describe('the keyed ops', () => {
  const PACK_OFF = { op: 'setPackEnabled', packId: 'pack-a', value: false };
  const OUT_OF_POOL = {
    op: 'setFixed',
    characterKey: 'pack-a/char-a',
    param: 'inPool',
    value: false,
  };

  it.each([
    ['setPackEnabled false', PACK_OFF],
    ['setPackEnabled true', { ...PACK_OFF, value: true }],
    ['setFixed inPool false', OUT_OF_POOL],
    ['setFixed inPool true', { ...OUT_OF_POOL, value: true }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(settingsOpSchema, value);
  });

  it('round-trips a patch with a set and both keyed ops', () => {
    expectRoundTrip(settingsPatchSchema, {
      baseRev: 2,
      ops: [setDisplay(DISPLAY_ID), PACK_OFF, OUT_OF_POOL],
    });
  });

  it.each([
    ['setPackEnabled with an upper-case pack id', { ...PACK_OFF, packId: 'A' }],
    [
      'setPackEnabled with an all-digit pack id',
      { ...PACK_OFF, packId: '123' },
    ],
    [
      'setPackEnabled with a character key',
      { ...PACK_OFF, packId: 'pack-a/char-a' },
    ],
    ['setPackEnabled with a string value', { ...PACK_OFF, value: 'false' }],
    ['setPackEnabled with a null value', { ...PACK_OFF, value: null }],
    [
      'setPackEnabled with no value',
      { op: 'setPackEnabled', packId: 'pack-a' },
    ],
    ['setPackEnabled with an extra key', { ...PACK_OFF, field: 'packEnabled' }],
    [
      'setFixed with a pack id for a key',
      { ...OUT_OF_POOL, characterKey: 'pack-a' },
    ],
    [
      'setFixed with three parts',
      { ...OUT_OF_POOL, characterKey: 'pack-a/char-a/x' },
    ],
    [
      'setFixed with a bad character id',
      { ...OUT_OF_POOL, characterKey: 'pack-a/_x' },
    ],
    [
      'setFixed of a parameter not kept yet',
      { ...OUT_OF_POOL, param: 'scale', value: 1.5 },
    ],
    ['setFixed with a number value', { ...OUT_OF_POOL, value: 0 }],
    ['setFixed with no param', { ...OUT_OF_POOL, param: undefined }],
    ['setFixed with an extra key', { ...OUT_OF_POOL, packId: 'pack-a' }],
    [
      'a set that overwrites packEnabled whole',
      { op: 'set', field: 'packEnabled', value: { 'pack-a': false } },
    ],
    [
      'a set that overwrites fixedOverrides whole',
      { op: 'set', field: 'fixedOverrides', value: {} },
    ],
    ['an op unknown to this build', { op: 'removePack', packId: 'pack-a' }],
  ])('rejects %s', (_label, value) => {
    expectRejected(settingsOpSchema, value);
  });
});

describe('isPackEnabled and isInPool: settings.json ?? the stage default', () => {
  const values = {
    ...SETTINGS_DEFAULTS,
    packEnabled: { 'pack-a': false, 'pack-b': true },
    fixedOverrides: {
      'pack-a/char-a': { inPool: false },
      'pack-b/char-b': { inPool: true },
      'pack-b/char-c': {},
    },
  };

  it('are on when settings.json has no value', () => {
    expect(isPackEnabled(SETTINGS_DEFAULTS, 'pack-a')).toBe(true);
    expect(isInPool(SETTINGS_DEFAULTS, 'pack-a', 'char-a')).toBe(true);
    expect(isPackEnabled(values, 'pack-c')).toBe(true);
    expect(isInPool(values, 'pack-c', 'char-a')).toBe(true);
    expect(isInPool(values, 'pack-b', 'char-c')).toBe(true);
  });

  it("take settings.json's value when it has one", () => {
    expect(isPackEnabled(values, 'pack-a')).toBe(false);
    expect(isPackEnabled(values, 'pack-b')).toBe(true);
    expect(isInPool(values, 'pack-a', 'char-a')).toBe(false);
    expect(isInPool(values, 'pack-b', 'char-b')).toBe(true);
  });

  it('read one character only: the same id in another pack, or another character, is not affected', () => {
    expect(isInPool(values, 'pack-b', 'char-a')).toBe(true);
    expect(isInPool(values, 'pack-a', 'char-b')).toBe(true);
  });

  it('read 加入池子 the same whether or not the pack is 上場', () => {
    expect(isPackEnabled(values, 'pack-a')).toBe(false);
    expect(isInPool(values, 'pack-a', 'char-a')).toBe(false);
    expect(isInPool(values, 'pack-a', 'char-b')).toBe(true);
  });

  it('never read an inherited Object property as a value', () => {
    expect(isPackEnabled(SETTINGS_DEFAULTS, 'constructor')).toBe(true);
    expect(isInPool(SETTINGS_DEFAULTS, 'constructor', 'constructor')).toBe(
      true,
    );
    expect(
      isPackEnabled(
        {
          packEnabled: settingsFieldSchemas.packEnabled.parse({
            constructor: false,
          }),
        },
        'constructor',
      ),
    ).toBe(false);
  });
});
