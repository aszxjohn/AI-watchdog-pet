import { describe, expect, it } from 'vitest';
import {
  CHARACTER_HEIGHT_HINT_TOLERANCE,
  characterDefaultsSchema,
  FIXED_PARAM_DEFAULTS,
  fixedParamsSchema,
  isValidScale,
  RECOMMENDED_CHARACTER_HEIGHT,
  SCALE_GRID,
  scaleSchema,
  WANDER_ACTIVITY_CODES,
  WANDER_SPEED_CODES,
  wanderActivitySchema,
  wanderAreaSchema,
  wanderAreasSchema,
  wanderSchema,
  wanderSpeedSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { expectRuleIssue } from './issues';
import { changed, removed } from './samples';

const DEFAULTS = structuredClone(FIXED_PARAM_DEFAULTS);

describe('I/O matrix', () => {
  it('固定參數: the defaults are scale 1.0, in the pool, badges on, wander on over [6, 7, 8] at medium activity and speed', () => {
    expect(FIXED_PARAM_DEFAULTS).toStrictEqual({
      scale: 1,
      inPool: true,
      badges: true,
      wander: {
        enabled: true,
        areas: [6, 7, 8],
        activity: 'medium',
        speed: 'medium',
      },
    });
    expectRoundTrip(fixedParamsSchema, DEFAULTS);
  });

  it.each([0.45, 2.05, 1.05])('固定參數: scale %s is rejected', (scale) => {
    expect(isValidScale(scale)).toBe(false);
    expectRuleIssue(scaleSchema, scale, 'scale-off-grid', []);
    expectRuleIssue(
      fixedParamsSchema,
      changed(DEFAULTS, ['scale'], scale),
      'scale-off-grid',
      ['scale'],
    );
  });
});

describe('FIXED_PARAM_DEFAULTS', () => {
  it('cannot be changed at any level', () => {
    expect(Object.isFrozen(FIXED_PARAM_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(FIXED_PARAM_DEFAULTS.wander)).toBe(true);
    expect(Object.isFrozen(FIXED_PARAM_DEFAULTS.wander.areas)).toBe(true);
  });
});

describe('scale', () => {
  it('is 0.5 to 2.0 in steps of 0.1', () => {
    expect(SCALE_GRID).toStrictEqual({ min: 0.5, max: 2, step: 0.1 });
    expect(Object.isFrozen(SCALE_GRID)).toBe(true);
  });

  it('accepts every step, however it was added up', () => {
    let added = 0.5;
    for (let n = 0; n <= 15; n += 1) {
      const multiplied = 0.5 + n * 0.1;
      const decimal = Number((0.5 + n / 10).toFixed(1));
      for (const value of [added, multiplied, decimal]) {
        expect(isValidScale(value), String(value)).toBe(true);
        expectRoundTrip(scaleSchema, value);
      }
      added += 0.1;
    }
  });

  it.each([
    ['within the tolerance of a step', 1.2 + 5e-10, true],
    ['within the tolerance below min', 0.5 - 5e-10, true],
    ['past the tolerance of a step', 1.2 + 1e-8, false],
    ['below min', 0.4, false],
    ['above max', 2.1, false],
    ['zero', 0, false],
    ['negative', -1, false],
    ['infinite', Infinity, false],
    ['NaN', Number.NaN, false],
  ])('%s', (_label, value, valid) => {
    expect(isValidScale(value)).toBe(valid);
  });

  it.each([
    ['a string', '1.0'],
    ['null', null],
    ['infinite', Infinity],
  ])('the schema rejects %s', (_label, value) => {
    expectRejected(scaleSchema, value);
  });
});

describe('wander', () => {
  it('lists its activity and speed codes', () => {
    expect([...WANDER_ACTIVITY_CODES]).toStrictEqual(['low', 'medium', 'high']);
    expect([...WANDER_SPEED_CODES]).toStrictEqual(['slow', 'medium', 'fast']);
  });

  it.each([
    ['the defaults', DEFAULTS.wander],
    [
      'every area, off, high and fast',
      {
        enabled: false,
        areas: [8, 0, 1, 2, 3, 4, 5, 6, 7],
        activity: 'high',
        speed: 'fast',
      },
    ],
    [
      'one area, low and slow',
      { enabled: true, areas: [4], activity: 'low', speed: 'slow' },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(wanderSchema, value);
  });

  it.each([
    ['no areas', changed(DEFAULTS.wander, ['areas'], [])],
    ['area 9', changed(DEFAULTS.wander, ['areas'], [9])],
    ['area -1', changed(DEFAULTS.wander, ['areas'], [-1])],
    ['a fractional area', changed(DEFAULTS.wander, ['areas'], [6.5])],
    [
      'ten areas',
      changed(DEFAULTS.wander, ['areas'], [0, 1, 2, 3, 4, 5, 6, 7, 8, 8]),
    ],
    ['an unknown activity', changed(DEFAULTS.wander, ['activity'], 'max')],
    ['an unknown speed', changed(DEFAULTS.wander, ['speed'], 'medium-fast')],
    ['enabled as a string', changed(DEFAULTS.wander, ['enabled'], 'true')],
    ['no speed', removed(DEFAULTS.wander, ['speed'])],
    ['an extra field', changed(DEFAULTS.wander, ['range'], 3)],
  ])('rejects %s', (_label, value) => {
    expectRejected(wanderSchema, value);
  });

  it('rejects an area twice as duplicate-wander-area', () => {
    expectRuleIssue(
      wanderSchema,
      changed(DEFAULTS.wander, ['areas'], [6, 7, 6]),
      'duplicate-wander-area',
      ['areas'],
    );
  });

  it('the areas schema alone takes 1 to 9 unique cells', () => {
    expectRoundTrip(wanderAreasSchema, [0]);
    expectRuleIssue(wanderAreasSchema, [1, 1], 'duplicate-wander-area', []);
  });

  it.each([0, 4, 8])('area %s is a cell', (area) => {
    expectRoundTrip(wanderAreaSchema, area);
  });

  it.each([-1, 9, 1.5, '6', null])('%o is not a cell', (area) => {
    expectRejected(wanderAreaSchema, area);
  });

  it.each(WANDER_ACTIVITY_CODES)('activity %s round-trips', (code) => {
    expectRoundTrip(wanderActivitySchema, code);
  });

  it.each(WANDER_SPEED_CODES)('speed %s round-trips', (code) => {
    expectRoundTrip(wanderSpeedSchema, code);
  });

  it.each(['slow', 'fast', 'Medium', '', null])(
    'activity %o is rejected',
    (code) => {
      expectRejected(wanderActivitySchema, code);
    },
  );

  it.each(['low', 'high', 'Medium', '', null])(
    'speed %o is rejected',
    (code) => {
      expectRejected(wanderSpeedSchema, code);
    },
  );
});

describe('fixedParamsSchema', () => {
  it.each([
    ['no inPool', removed(DEFAULTS, ['inPool'])],
    ['badges as a number', changed(DEFAULTS, ['badges'], 1)],
    ['no wander', removed(DEFAULTS, ['wander'])],
    ['an extra field', changed(DEFAULTS, ['hidden'], false)],
    ['a list', [DEFAULTS]],
  ])('rejects %s', (_label, value) => {
    expectRejected(fixedParamsSchema, value);
  });
});

describe('characterDefaultsSchema', () => {
  it.each([
    ['nothing', {}],
    ['scale only', { scale: 1.5 }],
    ['wander only, one field', { wander: { speed: 'fast' } }],
    ['an empty wander', { wander: {} }],
    ['both, wander complete', { scale: 0.5, wander: DEFAULTS.wander }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(characterDefaultsSchema, value);
  });

  it.each([
    ['inPool', { inPool: false }],
    ['badges', { badges: false }],
    ['an unknown field', { size: 2 }],
    ['a bad scale', { scale: 1.05 }],
    ['an area twice', { wander: { areas: [8, 8] } }],
    ['an unknown wander field', { wander: { range: 3 } }],
    ['a bad wander value', { wander: { areas: [] } }],
    ['wander set to undefined', { wander: undefined }],
  ])('rejects %s', (_label, value) => {
    expectRejected(characterDefaultsSchema, value);
  });
});

describe('character height hint', () => {
  it('recommends 110 base pixels, hinting outside 82.5 to 137.5', () => {
    expect(RECOMMENDED_CHARACTER_HEIGHT).toBe(110);
    expect(CHARACTER_HEIGHT_HINT_TOLERANCE).toBe(0.25);
    expect(
      RECOMMENDED_CHARACTER_HEIGHT * (1 - CHARACTER_HEIGHT_HINT_TOLERANCE),
    ).toBe(82.5);
    expect(
      RECOMMENDED_CHARACTER_HEIGHT * (1 + CHARACTER_HEIGHT_HINT_TOLERANCE),
    ).toBe(137.5);
  });
});
