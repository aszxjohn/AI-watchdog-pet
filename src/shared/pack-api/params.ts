import { z } from '../zod-setup';
import {
  addRuleIssue,
  FLOAT_TOLERANCE,
  fitsGrid,
  idSchema,
  labelSchema,
  repeatedIndexes,
  withoutProtoKey,
} from './common';

/**
 * Character parameters: what a manifest declares for each character, and
 * the values the stage hands the pack. Each declaration's `default` must be
 * a valid value of that declaration; an `asset` parameter's options must
 * also be keys in the manifest's `assets`, which manifestSchema checks.
 */

/** Fields every parameter declaration has. */
const commonFields = {
  /** Unique within its character. */
  key: idSchema,
  label: labelSchema,
};

/** The step an `int` parameter has when it declares none. */
export const INT_PARAM_DEFAULT_STEP = 1;

/** The range and step of an `int` or `number` declaration. */
interface DeclaredGrid {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

function isValidInt(param: DeclaredGrid, value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    fitsGrid(
      value as number,
      {
        min: param.min,
        max: param.max,
        step: param.step ?? INT_PARAM_DEFAULT_STEP,
      },
      0,
    )
  );
}

function isValidNumber(param: DeclaredGrid, value: unknown): boolean {
  return typeof value === 'number' && fitsGrid(value, param, FLOAT_TOLERANCE);
}

/**
 * The rules an `int` or `number` declaration's own fields follow: `min` is
 * at most `max`; an `int`'s `max` is on a step from `min`; `default` is a
 * valid value.
 */
function checkGridDecl(
  param: DeclaredGrid & { readonly type: 'int' | 'number'; default: number },
  ctx: z.RefinementCtx,
): void {
  if (param.min > param.max) {
    addRuleIssue(ctx, 'param-min-above-max', 'min is at most max', ['max']);
  } else if (
    param.type === 'int' &&
    (param.max - param.min) % (param.step ?? INT_PARAM_DEFAULT_STEP) !== 0
  ) {
    addRuleIssue(ctx, 'int-max-off-grid', 'max is on a step from min', ['max']);
  }
  const valid =
    param.type === 'int'
      ? isValidInt(param, param.default)
      : isValidNumber(param, param.default);
  if (!valid) {
    addRuleIssue(
      ctx,
      'invalid-param-default',
      'default is within min..max and on a step from min',
      ['default'],
    );
  }
}

export const boolParamSchema = z.strictObject({
  type: z.literal('bool'),
  ...commonFields,
  default: z.boolean(),
});

/**
 * Whole numbers from `min` to `max`, on min + n × step (step defaults to
 * INT_PARAM_DEFAULT_STEP); `max` itself is on a step.
 */
export const intParamSchema = z
  .strictObject({
    type: z.literal('int'),
    ...commonFields,
    min: z.int(),
    max: z.int(),
    step: z.int().positive().exactOptional(),
    default: z.int(),
  })
  .superRefine(checkGridDecl);

/**
 * Numbers from `min` to `max`, on min + n × step when a step is declared,
 * each to within FLOAT_TOLERANCE (scaled, see fitsGrid). `max` need not be
 * on a step.
 */
export const numberParamSchema = z
  .strictObject({
    type: z.literal('number'),
    ...commonFields,
    min: z.number(),
    max: z.number(),
    step: z.number().positive().exactOptional(),
    default: z.number(),
  })
  .superRefine(checkGridDecl);

/** One option of a `choice` parameter: an id-style value and its label. */
export const choiceOptionSchema = z.strictObject({
  value: idSchema,
  label: labelSchema,
});

/** One of at least two options, values unique. */
export const choiceParamSchema = z
  .strictObject({
    type: z.literal('choice'),
    ...commonFields,
    options: z.array(choiceOptionSchema).min(2),
    default: idSchema,
  })
  .superRefine((param, ctx) => {
    const values = param.options.map((option) => option.value);
    for (const i of repeatedIndexes(values)) {
      addRuleIssue(ctx, 'duplicate-choice-value', 'choice values are unique', [
        'options',
        i,
        'value',
      ]);
    }
    if (!values.includes(param.default)) {
      addRuleIssue(
        ctx,
        'choice-default-not-option',
        'default is one of the option values',
        ['default'],
      );
    }
  });

/** One of at least one asset key, keys unique. */
export const assetParamSchema = z
  .strictObject({
    type: z.literal('asset'),
    ...commonFields,
    options: z.array(idSchema).min(1),
    default: idSchema,
  })
  .superRefine((param, ctx) => {
    for (const i of repeatedIndexes(param.options)) {
      addRuleIssue(ctx, 'duplicate-asset-option', 'asset options are unique', [
        'options',
        i,
      ]);
    }
    if (!param.options.includes(param.default)) {
      addRuleIssue(
        ctx,
        'asset-default-not-option',
        'default is one of the options',
        ['default'],
      );
    }
  });

export const PARAM_TYPES = [
  'bool',
  'int',
  'number',
  'choice',
  'asset',
] as const;

/** Any parameter declaration, told apart by `type`. */
export const paramDeclSchema = z.discriminatedUnion('type', [
  boolParamSchema,
  intParamSchema,
  numberParamSchema,
  choiceParamSchema,
  assetParamSchema,
]);

export type ParamDecl = z.infer<typeof paramDeclSchema>;

export type ParamType = ParamDecl['type'];

/** One parameter value: a bool, a number, or a choice value or asset key. */
export const paramValueSchema = z.union([z.boolean(), z.number(), z.string()]);

export type ParamValue = z.infer<typeof paramValueSchema>;

/** A character's parameter values by parameter key. */
export const paramValuesSchema = withoutProtoKey(
  z.record(idSchema, paramValueSchema),
);

export type ParamValues = z.infer<typeof paramValuesSchema>;

/**
 * Whether `value` is a valid value of `param` as declared: the right type,
 * within range and on a step, or one of the options. An `asset` value is
 * only checked against the options; manifestSchema checks that the options
 * are in `assets`. Story 3.6 uses this to decide whether a user's override
 * still applies.
 */
export function isValidParamValue(
  param: ParamDecl,
  value: unknown,
): value is ParamValue {
  switch (param.type) {
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return isValidInt(param, value);
    case 'number':
      return isValidNumber(param, value);
    case 'choice':
      return param.options.some((option) => option.value === value);
    case 'asset':
      return param.options.some((key) => key === value);
  }
}
