import { describe, expect, it } from 'vitest';
import { DETECTION_ID_MAX_LENGTH } from '../../src/shared/detection-events';
import {
  POOL_SCHEMA_VERSION,
  poolFileSchema,
  poolSetReleasedInputSchema,
  sortedSessionKeys,
  stagePoolSchema,
} from '../../src/shared/pool';
import { expectRejected, expectRoundTrip } from './schema-helpers';

/** The Design Notes example, with a real-looking Claude Code key. */
const FILE = {
  schemaVersion: 1,
  released: ['claude-code:00000000-0000-4000-8000-000000000001', 'demo:3'],
};

describe('sortedSessionKeys', () => {
  it('sorts in code-unit order and keeps each key once', () => {
    expect(
      sortedSessionKeys([
        'demo:2',
        'codex:b',
        'demo:10',
        'codex:b',
        'cursor:a',
      ]),
    ).toStrictEqual(['codex:b', 'cursor:a', 'demo:10', 'demo:2']);
  });

  it('leaves its input as it was', () => {
    const keys = Object.freeze(['demo:2', 'demo:1'] as const);
    sortedSessionKeys(keys);
    expect(keys).toStrictEqual(['demo:2', 'demo:1']);
  });
});

describe('poolFileSchema (assignments.json)', () => {
  it('is at schemaVersion 1', () => {
    expect(POOL_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    ['the design-notes file', FILE],
    ['nothing released', { schemaVersion: 1, released: [] }],
    [
      'keys in any order, one repeated (the store sorts them on reading)',
      { schemaVersion: 1, released: ['demo:3', 'codex:a', 'demo:3'] },
    ],
    [
      'a native id with a colon',
      { schemaVersion: 1, released: ['cursor:a:b'] },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(poolFileSchema, value);
  });

  it.each([
    ['no schemaVersion', { released: [] }],
    ['schemaVersion 2', { ...FILE, schemaVersion: 2 }],
    ['schemaVersion as a string', { ...FILE, schemaVersion: '1' }],
    ['no released list', { schemaVersion: 1 }],
    ['released as an object', { schemaVersion: 1, released: { a: 1 } }],
    ['an unknown source', { schemaVersion: 1, released: ['vim:1'] }],
    ['an empty native id', { schemaVersion: 1, released: ['demo:'] }],
    [
      'a native id past the limit',
      {
        schemaVersion: 1,
        released: [`demo:${'x'.repeat(DETECTION_ID_MAX_LENGTH + 1)}`],
      },
    ],
    ['a control character', { schemaVersion: 1, released: ['demo:1\n'] }],
    ['a number for a key', { schemaVersion: 1, released: [1] }],
    ['an unknown field', { ...FILE, actors: {} }],
    ['a list', [FILE]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(poolFileSchema, value);
  });
});

describe('stagePoolSchema (StageView pool section)', () => {
  it.each([
    ['nothing released', { released: [] }],
    ['one key', { released: ['demo:1'] }],
    ['sorted keys', { released: ['claude-code:x', 'codex:a', 'demo:1'] }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stagePoolSchema, value);
  });

  it.each([
    ['keys out of order', { released: ['demo:1', 'codex:a'] }],
    ['a key twice', { released: ['demo:1', 'demo:1'] }],
    ['a bad key', { released: ['demo'] }],
    ['no list', {}],
    ['an extra field', { released: [], actors: [] }],
    ['a bare list', ['demo:1']],
  ])('rejects %s', (_label, value) => {
    expectRejected(stagePoolSchema, value);
  });
});

describe('poolSetReleasedInputSchema', () => {
  it.each([
    ['release', ['demo:1', true]],
    ['show again', ['claude-code:00000000-0000-4000-8000-000000000001', false]],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(poolSetReleasedInputSchema, value);
  });

  it.each([
    ['no arguments', []],
    ['no flag', ['demo:1']],
    ['a flag as a string', ['demo:1', 'true']],
    ['a bad key', ['vim:1', true]],
    ['an object for the key', [{ sessionKey: 'demo:1' }, true]],
    ['an extra argument', ['demo:1', true, true]],
  ])('rejects %s', (_label, value) => {
    expectRejected(poolSetReleasedInputSchema, value);
  });
});
