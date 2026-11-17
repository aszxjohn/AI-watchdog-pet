/**
 * src/shared/params (Story 3.6, AD-23): the pure rules for a character's
 * effective parameters and fixed parameters.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_PARAM_DEFAULTS,
  fixedParamsSchema,
  type ParamDecl,
  paramValuesSchema,
} from '../../src/shared/pack-api';
import {
  effectiveFixed,
  effectiveParams,
  type FixedParamsOverride,
} from '../../src/shared/params';
import { fixedOverrideSchema } from '../../src/shared/settings';
import { stageFixedParamsSchema } from '../../src/shared/stage-view';

/** One declaration of each type, as a manifest declares them. */
const DECLS: ParamDecl[] = [
  { key: 'glow', label: '發光', type: 'bool', default: true },
  {
    key: 'blink-every',
    label: '眨眼間隔',
    type: 'int',
    min: 1,
    max: 9,
    step: 2,
    default: 3,
  },
  {
    key: 'bob',
    label: '上下擺動',
    type: 'number',
    min: 0,
    max: 8,
    step: 0.5,
    default: 2,
  },
  {
    key: 'mood',
    label: '心情',
    type: 'choice',
    options: [
      { value: 'calm', label: '平靜' },
      { value: 'busy', label: '忙碌' },
    ],
    default: 'calm',
  },
  {
    key: 'skin',
    label: '外觀',
    type: 'asset',
    options: ['skin-plain', 'skin-dots'],
    default: 'skin-plain',
  },
];

const DEFAULTS = {
  glow: true,
  'blink-every': 3,
  bob: 2,
  mood: 'calm',
  skin: 'skin-plain',
};

/** The stage defaults as plain values (FIXED_PARAM_DEFAULTS is frozen). */
const STAGE_FIXED = {
  scale: 1,
  inPool: true,
  badges: true,
  wander: {
    enabled: true,
    areas: [6, 7, 8],
    activity: 'medium',
    speed: 'medium',
  },
};

describe('effectiveParams', () => {
  it('is each declared key with its default when there is no override, frozen', () => {
    const values = effectiveParams(DECLS);

    expect(values).toStrictEqual(DEFAULTS);
    expect(Object.isFrozen(values)).toBe(true);
    expect(paramValuesSchema.safeParse(values).success).toBe(true);
  });

  it('is empty for a character that declares no parameter', () => {
    expect(effectiveParams([], { glow: false })).toStrictEqual({});
  });

  it('does not take an override inherited from the prototype', () => {
    const overrides = Object.create({ glow: false }) as Record<string, unknown>;
    expect(effectiveParams(DECLS, overrides).glow).toBe(true);
  });
});

describe('effectiveFixed', () => {
  it('answers a frozen value, the wander and its areas included, that shares no list with its inputs', () => {
    const areas = [0, 1];
    const fixed = effectiveFixed({ wander: { areas } }, undefined);

    expect(Object.isFrozen(fixed)).toBe(true);
    expect(Object.isFrozen(fixed.wander)).toBe(true);
    expect(Object.isFrozen(fixed.wander.areas)).toBe(true);
    expect(fixed.wander.areas).not.toBe(areas);
    expect(fixed.wander.areas).not.toBe(FIXED_PARAM_DEFAULTS.wander.areas);
    expect(effectiveFixed(undefined, undefined).wander.areas).not.toBe(
      FIXED_PARAM_DEFAULTS.wander.areas,
    );
  });

  it("takes the user's override first for every fixed parameter, wander field by field", () => {
    expect(
      effectiveFixed(
        { scale: 1.5, wander: { areas: [0], speed: 'slow' } },
        {
          scale: 0.7,
          inPool: false,
          badges: false,
          wander: { speed: 'fast', activity: 'high' },
        },
      ),
    ).toStrictEqual({
      scale: 0.7,
      inPool: false,
      badges: false,
      wander: {
        enabled: true,
        areas: [0],
        activity: 'high',
        speed: 'fast',
      },
    });
  });

  it('takes every wander field from the manifest when it gives them all', () => {
    const wander = {
      enabled: false,
      areas: [3, 4],
      activity: 'low' as const,
      speed: 'fast' as const,
    };
    expect(effectiveFixed({ wander }, undefined).wander).toStrictEqual(wander);
  });

  it('answers a value the fixed parameter schemas take', () => {
    const fixed = effectiveFixed(
      { scale: 2, wander: { areas: [8] } },
      { inPool: false },
    );
    expect(fixedParamsSchema.safeParse(fixed).success).toBe(true);
    expect(stageFixedParamsSchema.safeParse(fixed).success).toBe(true);
  });

  it('passes over an override that is not a valid value: the manifest default, else the stage default, takes its place', () => {
    const defaults = {
      scale: 1.5,
      wander: { areas: [0, 1], activity: 'low', speed: 'fast' },
    } as const;
    const bad = {
      scale: 1.05,
      inPool: 'no',
      badges: 1,
      wander: { enabled: 'yes', areas: [], activity: 'wild', speed: 'warp' },
    } as unknown as FixedParamsOverride;

    expect(
      effectiveFixed(
        { ...defaults, wander: { ...defaults.wander, areas: [0, 1] } },
        bad,
      ),
    ).toStrictEqual({
      scale: 1.5,
      inPool: true,
      badges: true,
      wander: { enabled: true, areas: [0, 1], activity: 'low', speed: 'fast' },
    });
    expect(effectiveFixed(undefined, bad)).toStrictEqual(STAGE_FIXED);
  });

  it.each([
    ['repeated areas', [6, 6]],
    ['an area off the grid', [9]],
    ['too many areas', [0, 1, 2, 3, 4, 5, 6, 7, 8, 0]],
    ['areas that are not a list', 6],
  ])('passes over an override of %s', (_label, areas) => {
    const override = { wander: { areas } } as unknown as FixedParamsOverride;
    expect(effectiveFixed(undefined, override).wander.areas).toStrictEqual([
      6, 7, 8,
    ]);
  });

  it.each([
    ['off the grid', 0.55],
    ['below the range', 0.4],
    ['above the range', 2.1],
    ['not a number', '1'],
  ])('passes over a scale override %s', (_label, scale) => {
    const override = { scale } as unknown as FixedParamsOverride;
    expect(effectiveFixed({ scale: 0.8 }, override).scale).toBe(0.8);
    expect(effectiveFixed(undefined, override).scale).toBe(1);
  });

  it('takes a valid override at the edges of the scale range', () => {
    expect(effectiveFixed(undefined, { scale: 0.5 }).scale).toBe(0.5);
    expect(effectiveFixed(undefined, { scale: 2 }).scale).toBe(2);
  });

  it("takes settings' fixedOverrides entries as they are kept", () => {
    const kept = fixedOverrideSchema.parse({ inPool: false });
    expect(effectiveFixed(undefined, kept).inPool).toBe(false);
  });
});

describe('I/O matrix', () => {
  it('包預設: no override gives exactly the declared keys, each with its default', () => {
    const values = effectiveParams(DECLS, {});
    expect(Object.keys(values)).toStrictEqual(DECLS.map((decl) => decl.key));
    expect(values).toStrictEqual(DEFAULTS);
  });

  it('固定參數預設: no manifest defaults and no override: scale 1, inPool on, badges on, the stage wander', () => {
    expect(effectiveFixed(undefined, undefined)).toStrictEqual(STAGE_FIXED);
    expect(effectiveFixed({}, {})).toStrictEqual(STAGE_FIXED);
  });

  it('manifest 預設: defaults.scale 1.5 and a wander giving only areas: scale 1.5, areas from the manifest, the other wander fields from the stage', () => {
    expect(
      effectiveFixed({ scale: 1.5, wander: { areas: [0, 4] } }, undefined),
    ).toStrictEqual({
      ...STAGE_FIXED,
      scale: 1.5,
      wander: { ...STAGE_FIXED.wander, areas: [0, 4] },
    });
  });

  it('加入池子覆蓋: inPool false in the override turns inPool off and leaves the other fixed parameters as they were', () => {
    const defaults = { scale: 0.9, wander: { speed: 'slow' } } as const;
    const without = effectiveFixed(defaults, undefined);
    const withOverride = effectiveFixed(defaults, { inPool: false });

    expect(withOverride).toStrictEqual({ ...without, inPool: false });
    expect(without.inPool).toBe(true);
  });

  it('覆蓋值規則: a valid override is taken; one out of range, off the step, not an option, of the wrong type or for an undeclared key is not; the overrides are left unchanged', () => {
    const overrides = Object.freeze({
      glow: false,
      'blink-every': 4,
      bob: 8.5,
      mood: 'sleepy',
      skin: 'skin-dots',
      tail: 'long',
    });
    const before = JSON.stringify(overrides);

    expect(effectiveParams(DECLS, overrides)).toStrictEqual({
      glow: false,
      'blink-every': 3,
      bob: 2,
      mood: 'calm',
      skin: 'skin-dots',
    });
    expect(JSON.stringify(overrides)).toBe(before);

    expect(
      effectiveParams(DECLS, {
        glow: 'yes',
        'blink-every': 11,
        bob: 1.25,
        mood: 'busy',
        skin: 'skin-other',
      }),
    ).toStrictEqual({
      glow: true,
      'blink-every': 3,
      bob: 2,
      mood: 'busy',
      skin: 'skin-plain',
    });
    expect(
      effectiveParams(DECLS, { 'blink-every': 9, bob: 7.5 }),
    ).toMatchObject({ 'blink-every': 9, bob: 7.5 });
    expect(effectiveParams(DECLS, { 'blink-every': 2.5 })).toMatchObject({
      'blink-every': 3,
    });
  });

  it('參數與固定分開: a declared parameter keyed scale stays among the parameters; the fixed scale is worked out on its own', () => {
    const decls: ParamDecl[] = [
      {
        key: 'scale',
        label: '縮放',
        type: 'number',
        min: 0,
        max: 10,
        default: 7,
      },
    ];
    const params = effectiveParams(decls, { scale: 3 });
    const fixed = effectiveFixed({ scale: 1.2 }, undefined);

    expect(params).toStrictEqual({ scale: 3 });
    expect(fixed.scale).toBe(1.2);
    expect(Object.keys(fixed)).toStrictEqual([
      'scale',
      'inPool',
      'badges',
      'wander',
    ]);
  });
});
