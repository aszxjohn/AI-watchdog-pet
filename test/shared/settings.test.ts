import { describe, expect, it } from 'vitest';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_FIELDS,
  SETTINGS_PATCH_MAX_OPS,
  SETTINGS_SCHEMA_VERSION,
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
