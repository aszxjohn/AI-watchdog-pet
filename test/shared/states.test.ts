import { describe, expect, it } from 'vitest';
import {
  STATE_CODES,
  STATE_DISPLAY_NAMES,
  stateCodeSchema,
} from '../../src/shared/states';
import { expectRejected, expectRoundTrip } from './schema-helpers';

describe('state codes', () => {
  it('are exactly the 8 codes of AD-6', () => {
    expect([...STATE_CODES]).toStrictEqual([
      'waiting',
      'thinking',
      'working',
      'approval',
      'decision',
      'done',
      'idle',
      'error',
    ]);
  });

  it('display names cover every code, and only those codes', () => {
    expect(Object.keys(STATE_DISPLAY_NAMES).sort()).toStrictEqual(
      [...STATE_CODES].sort(),
    );
  });

  it('display names match the Consistency Conventions table and are distinct', () => {
    expect(STATE_DISPLAY_NAMES).toStrictEqual({
      waiting: '等你回覆',
      thinking: '思考中',
      working: '工作中',
      approval: '要你批准',
      decision: '要你決定',
      done: '做完了',
      idle: '休息中',
      error: '出錯了',
    });
    const names = Object.values(STATE_DISPLAY_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('display names cannot be changed at runtime', () => {
    expect(Object.isFrozen(STATE_DISPLAY_NAMES)).toBe(true);
  });
});

describe('stateCodeSchema', () => {
  it.each(STATE_CODES)('round-trips %s', (code) => {
    expectRoundTrip(stateCodeSchema, code);
  });

  it.each([
    ['unknown code', 'sleeping'],
    ['wrong case', 'Waiting'],
    ['display name instead of code', '等你回覆'],
    ['empty string', ''],
    ['number', 0],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expectRejected(stateCodeSchema, value);
  });
});
