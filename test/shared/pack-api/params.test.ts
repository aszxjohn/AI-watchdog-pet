import { describe, expect, it } from 'vitest';
import {
  assetParamSchema,
  boolParamSchema,
  choiceOptionSchema,
  choiceParamSchema,
  INT_PARAM_DEFAULT_STEP,
  intParamSchema,
  isValidParamValue,
  numberParamSchema,
  type PackApiIssueRule,
  PARAM_TYPES,
  type ParamDecl,
  paramDeclSchema,
  paramValueSchema,
  paramValuesSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { expectRuleIssue } from './issues';
import {
  ASSET_PARAM as ASSET,
  BOOL_PARAM as BOOL,
  changed,
  CHOICE_PARAM as CHOICE,
  INT_PARAM as INT,
  NUMBER_PARAM as NUMBER,
  removed,
  withProtoKey,
} from './samples';

describe('I/O matrix', () => {
  it.each([
    ['below min', 0],
    ['above max', 22],
    ['off the step from min', 5],
  ])('參數預設不合法: an int default %s is rejected', (_label, value) => {
    for (const schema of [intParamSchema, paramDeclSchema]) {
      expectRuleIssue(
        schema,
        changed(INT, ['default'], value),
        'invalid-param-default',
        ['default'],
      );
    }
  });

  it('參數預設不合法: an int default that is not whole is rejected', () => {
    expectRejected(intParamSchema, changed(INT, ['default'], 6.5));
    expectRejected(paramDeclSchema, changed(INT, ['default'], 6.5));
  });

  it('參數預設不合法: a choice default that is not an option value is rejected', () => {
    for (const schema of [choiceParamSchema, paramDeclSchema]) {
      expectRuleIssue(
        schema,
        changed(CHOICE, ['default'], 'angry'),
        'choice-default-not-option',
        ['default'],
      );
    }
  });
});

describe('parameter declarations', () => {
  it('has the five types, one per declaration schema', () => {
    expect([...PARAM_TYPES]).toStrictEqual([
      'bool',
      'int',
      'number',
      'choice',
      'asset',
    ]);
    expect(
      paramDeclSchema.options.map((option) => option.shape.type.value),
    ).toStrictEqual([...PARAM_TYPES]);
  });

  it.each([
    ['bool', boolParamSchema, BOOL],
    ['int', intParamSchema, INT],
    ['int without a step', intParamSchema, removed(INT, ['step'])],
    ['number', numberParamSchema, NUMBER],
    ['number without a step', numberParamSchema, removed(NUMBER, ['step'])],
    ['choice', choiceParamSchema, CHOICE],
    ['asset', assetParamSchema, ASSET],
  ])('round-trips %s, alone and as a declaration', (_label, schema, value) => {
    expectRoundTrip(schema, value);
    expectRoundTrip(paramDeclSchema, value);
  });

  it.each([
    [
      'an int default on min, on max and on a step',
      [
        changed(INT, ['default'], 2),
        changed(INT, ['default'], 20),
        changed(INT, ['default'], 14),
      ],
    ],
    ['an int with min equal to max', [{ ...INT, min: 5, max: 5, default: 5 }]],
    [
      'negative int bounds',
      [{ ...INT, min: -10, max: -2, step: 4, default: -6 }],
    ],
    [
      'number defaults a few ULPs off a 0.1 step, and at max',
      [
        changed(NUMBER, ['default'], 0.1 + 0.2),
        changed(NUMBER, ['default'], 0.7),
        changed(NUMBER, ['default'], 1),
      ],
    ],
    [
      'a number with no step and any default in range',
      [changed(removed(NUMBER, ['step']), ['default'], 0.123456)],
    ],
    [
      'an asset with one option',
      [{ ...ASSET, options: ['body-plain'], default: 'body-plain' }],
    ],
    ['a 64-character label', [changed(BOOL, ['label'], '字'.repeat(64))]],
    ['a number whose max is off its step', [changed(NUMBER, ['max'], 0.95)]],
    [
      'number defaults on 0.1 steps from a min far from 0',
      [10_000_000.4, 10_000_000.6, 10_000_001.2, 10_000_002].map((value) => ({
        ...NUMBER,
        min: 10_000_000.3,
        max: 10_000_002,
        default: value,
      })),
    ],
    [
      'number defaults on 0.3 steps from a negative min',
      [-1.5, -0.9, 0.3, 1.5].map((value) => ({
        ...NUMBER,
        min: -1.5,
        max: 1.5,
        step: 0.3,
        default: value,
      })),
    ],
    [
      'an int on steps of 3 from a negative min',
      [{ ...INT, min: -7, max: 5, step: 3, default: -1 }],
    ],
  ])('accepts %s', (_label, values) => {
    for (const value of values) {
      expectRoundTrip(paramDeclSchema, value);
    }
  });

  it.each([
    ['an unknown type', changed(BOOL, ['type'], 'color')],
    ['no type', removed(BOOL, ['type'])],
    ['a bad key', changed(BOOL, ['key'], 'Glow')],
    ['no key', removed(BOOL, ['key'])],
    ['an empty label', changed(BOOL, ['label'], '')],
    ['a 65-character label', changed(BOOL, ['label'], 'x'.repeat(65))],
    ['an extra field', changed(BOOL, ['hint'], 'x')],
    ['a bool default that is a string', changed(BOOL, ['default'], 'true')],
    ['a bool with no default', removed(BOOL, ['default'])],
    ['an int step of 0', changed(INT, ['step'], 0)],
    ['a negative int step', changed(INT, ['step'], -2)],
    ['a fractional int step', changed(INT, ['step'], 0.5)],
    ['a fractional int min', changed(INT, ['min'], 1.5)],
    ['an int max that is a string', changed(INT, ['max'], '20')],
    ['an infinite int max', changed(INT, ['max'], Infinity)],
    ['a number step of 0', changed(NUMBER, ['step'], 0)],
    ['an infinite number max', changed(NUMBER, ['max'], Infinity)],
    ['a NaN number default', changed(NUMBER, ['default'], Number.NaN)],
    [
      'a choice with one option',
      { ...CHOICE, options: [CHOICE.options[0]], default: 'calm' },
    ],
    [
      'a choice value that is not an id',
      changed(CHOICE, ['options', 1, 'value'], 'Busy'),
    ],
    [
      'a choice option with an extra field',
      changed(CHOICE, ['options', 1, 'icon'], 'x'),
    ],
    ['a choice option with no label', removed(CHOICE, ['options', 1, 'label'])],
    ['an asset with no options', { ...ASSET, options: [], default: 'x1' }],
    ['an asset option that is not an id', changed(ASSET, ['options', 0], 'A')],
  ])('rejects %s', (_label, value) => {
    expectRejected(paramDeclSchema, value);
  });

  it.each<[string, unknown, PackApiIssueRule, PropertyKey[]]>([
    [
      'an int min above max',
      { ...INT, min: 10, max: 2, default: 6 },
      'param-min-above-max',
      ['max'],
    ],
    [
      'a number min above max',
      { ...NUMBER, min: 1, max: 0, default: 0.5 },
      'param-min-above-max',
      ['max'],
    ],
    [
      'an int max off the step from min',
      changed(INT, ['max'], 19),
      'int-max-off-grid',
      ['max'],
    ],
    [
      'an int max off a step of 3 from a negative min',
      { ...INT, min: -7, max: 6, step: 3, default: -1 },
      'int-max-off-grid',
      ['max'],
    ],
    [
      'a number default below min',
      changed(NUMBER, ['default'], -0.1),
      'invalid-param-default',
      ['default'],
    ],
    [
      'a number default above max',
      changed(NUMBER, ['default'], 1.1),
      'invalid-param-default',
      ['default'],
    ],
    [
      'a number default off the step',
      changed(NUMBER, ['default'], 0.35),
      'invalid-param-default',
      ['default'],
    ],
    [
      'a number default half a step off, from a min far from 0',
      {
        ...NUMBER,
        min: 10_000_000.3,
        max: 10_000_002,
        default: 10_000_000.65,
      },
      'invalid-param-default',
      ['default'],
    ],
    [
      'a number default off a 0.3 step from a negative min',
      { ...NUMBER, min: -1.5, max: 1.5, step: 0.3, default: 0.2 },
      'invalid-param-default',
      ['default'],
    ],
    [
      'a choice value twice',
      changed(CHOICE, ['options', 1, 'value'], 'calm'),
      'duplicate-choice-value',
      ['options', 1, 'value'],
    ],
    [
      'an asset option twice',
      changed(ASSET, ['options', 1], 'body-plain'),
      'duplicate-asset-option',
      ['options', 1],
    ],
    [
      'an asset default not in the options',
      changed(ASSET, ['default'], 'sheet'),
      'asset-default-not-option',
      ['default'],
    ],
    ['a blank label', changed(BOOL, ['label'], '  '), 'blank-label', ['label']],
  ])('rejects %s as %s', (_label, value, rule, path) => {
    expectRuleIssue(paramDeclSchema, value, rule, path);
  });
});

describe('choiceOptionSchema', () => {
  it('round-trips an option', () => {
    expectRoundTrip(choiceOptionSchema, { value: 'calm', label: '平靜' });
  });

  it.each([
    ['a bad value', { value: 'c', label: '平靜' }],
    ['an empty label', { value: 'calm', label: '' }],
    ['an extra field', { value: 'calm', label: '平靜', x: 1 }],
  ])('rejects %s', (_label, value) => {
    expectRejected(choiceOptionSchema, value);
  });
});

describe('parameter values', () => {
  it.each([true, false, 0, -1.5, '', 'calm'])('a value may be %o', (value) => {
    expectRoundTrip(paramValueSchema, value);
  });

  it.each([null, undefined, Infinity, Number.NaN, [], {}])(
    'a value may not be %o',
    (value) => {
      expectRejected(paramValueSchema, value);
    },
  );

  it('round-trips a set of values by key', () => {
    expectRoundTrip(paramValuesSchema, {
      glow: true,
      'blink-every': 6,
      sway: 0.3,
      mood: 'busy',
    });
    expectRoundTrip(paramValuesSchema, {});
  });

  it.each([
    ['a bad key', { Glow: true }],
    ['a null value', { glow: null }],
    ['a list', [true]],
    ['null', null],
  ])('rejects a set of values with %s', (_label, value) => {
    expectRejected(paramValuesSchema, value);
  });

  it('rejects a set of values with a __proto__ key as reserved-key', () => {
    expectRuleIssue(
      paramValuesSchema,
      withProtoKey({ glow: true }, false),
      'reserved-key',
      [],
    );
  });
});

describe('isValidParamValue', () => {
  function decl(value: unknown): ParamDecl {
    return paramDeclSchema.parse(value);
  }

  it('the int step defaults to 1', () => {
    expect(INT_PARAM_DEFAULT_STEP).toBe(1);
    const noStep = decl(removed(INT, ['step']));
    expect(isValidParamValue(noStep, 3)).toBe(true);
    expect(isValidParamValue(noStep, 3.5)).toBe(false);
  });

  it.each<[string, unknown, unknown, boolean]>([
    ['bool true', BOOL, true, true],
    ['bool false', BOOL, false, true],
    ['bool as a number', BOOL, 1, false],
    ['bool as a string', BOOL, 'true', false],
    ['int on a step', INT, 8, true],
    ['int at max', INT, 20, true],
    ['int off the step', INT, 7, false],
    ['int below min', INT, 0, false],
    ['int above max', INT, 22, false],
    ['int as a string', INT, '8', false],
    ['int not whole', INT, 8.000_000_000_1, false],
    ['number a few ULPs off a step', NUMBER, 0.1 * 3, true],
    ['number off the step', NUMBER, 0.25, false],
    ['number within the tolerance above max', NUMBER, 1 + 1e-10, true],
    ['number past the tolerance above max', NUMBER, 1 + 1e-6, false],
    [
      'number on a 0.1 step from a min far from 0',
      { ...NUMBER, min: 10_000_000.3, max: 10_000_002, default: 10_000_000.3 },
      10_000_000.6,
      true,
    ],
    [
      'number off a 0.1 step from a min far from 0',
      { ...NUMBER, min: 10_000_000.3, max: 10_000_002, default: 10_000_000.3 },
      10_000_000.65,
      false,
    ],
    [
      'number on a 0.3 step from a negative min',
      { ...NUMBER, min: -1.5, max: 1.5, step: 0.3, default: 0 },
      -0.9,
      true,
    ],
    [
      'number off a 0.3 step from a negative min',
      { ...NUMBER, min: -1.5, max: 1.5, step: 0.3, default: 0 },
      -1,
      false,
    ],
    ['number as a string', NUMBER, '0.3', false],
    ['number infinite', removed(NUMBER, ['step']), Infinity, false],
    ['choice option', CHOICE, 'busy', true],
    ['choice label instead of value', CHOICE, '忙碌', false],
    ['choice other', CHOICE, 'angry', false],
    ['asset option', ASSET, 'body-plain', true],
    ['asset not an option', ASSET, 'sheet', false],
    ['asset as a number', ASSET, 0, false],
  ])('%s', (_label, param, value, valid) => {
    expect(isValidParamValue(decl(param), value)).toBe(valid);
  });
});
