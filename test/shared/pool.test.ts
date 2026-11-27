import { describe, expect, it } from 'vitest';
import { DETECTION_ID_MAX_LENGTH } from '../../src/shared/detection-events';
import { ACTOR_ID_MAX_LENGTH } from '../../src/shared/pack-api';
import {
  heldBackBy,
  POOL_SCHEMA_VERSION,
  POOL_SET_RELEASED_MANY_MAX_KEYS,
  poolAssignmentSchema,
  poolFileSchema,
  poolSetLockedInputSchema,
  poolSetLockOnInputSchema,
  poolSetReleasedInputSchema,
  poolSetReleasedManyInputSchema,
  sortedSessionKeys,
  stageActorSchema,
  stageActorsSchema,
  stagePoolSchema,
} from '../../src/shared/pool';
import { expectRejected, expectRoundTrip } from './schema-helpers';

const CLAUDE_KEY = 'claude-code:00000000-0000-4000-8000-000000000001';
const ASSIGNMENT = {
  sessionKey: CLAUDE_KEY,
  actorId: '0f6c1d2e-0000-4000-8000-00000000000a',
  characterKey: 'sample-pack/probe-a',
};

/** The Design Notes example, with a real-looking Claude Code key. */
const FILE = {
  schemaVersion: 3,
  released: [CLAUDE_KEY, 'demo:3'],
  locked: [],
  lockOn: false,
  assignments: [],
};

/** A file with an assignment (Story 3.4). */
const ASSIGNED_FILE = {
  ...FILE,
  released: ['demo:3'],
  assignments: [
    ASSIGNMENT,
    {
      sessionKey: 'demo:1',
      actorId: 'a2',
      characterKey: 'sample-pack/probe-b',
    },
  ],
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
  it('is at schemaVersion 3 (session bulk-lock)', () => {
    expect(POOL_SCHEMA_VERSION).toBe(3);
  });

  it.each([
    ['the design-notes file', FILE],
    ['nothing released', { ...FILE, released: [] }],
    [
      'keys in any order, one repeated (the store sorts them on reading)',
      { ...FILE, released: ['demo:3', 'codex:a', 'demo:3'] },
    ],
    ['a native id with a colon', { ...FILE, released: ['cursor:a:b'] }],
    [
      'locked keys in any order, 鎖定展示 on (session bulk-lock)',
      { ...FILE, locked: ['demo:3', CLAUDE_KEY], lockOn: true },
    ],
    ['assignments', ASSIGNED_FILE],
    [
      'assignments in any order (the store sorts them on reading)',
      {
        ...ASSIGNED_FILE,
        assignments: [...ASSIGNED_FILE.assignments].reverse(),
      },
    ],
    [
      'one character for two sessions (the pool ran out)',
      {
        ...ASSIGNED_FILE,
        assignments: [
          ASSIGNMENT,
          { ...ASSIGNMENT, sessionKey: 'demo:1', actorId: 'a2' },
        ],
      },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(poolFileSchema, value);
  });

  it.each([
    ['no schemaVersion', { ...FILE, schemaVersion: undefined }],
    ['schemaVersion 2', { ...FILE, schemaVersion: 2 }],
    ['schemaVersion 4', { ...FILE, schemaVersion: 4 }],
    ['schemaVersion as a string', { ...FILE, schemaVersion: '3' }],
    ['no released list', { ...FILE, released: undefined }],
    ['no assignments list', { ...FILE, assignments: undefined }],
    ['no locked list', { ...FILE, locked: undefined }],
    ['no lockOn', { ...FILE, lockOn: undefined }],
    ['a lockOn that is not a boolean', { ...FILE, lockOn: 'true' }],
    ['a bad locked key', { ...FILE, locked: ['vim:1'] }],
    ['released as an object', { ...FILE, released: { a: 1 } }],
    ['assignments as an object', { ...FILE, assignments: {} }],
    ['an unknown source', { ...FILE, released: ['vim:1'] }],
    ['an empty native id', { ...FILE, released: ['demo:'] }],
    [
      'a native id past the limit',
      {
        ...FILE,
        released: [`demo:${'x'.repeat(DETECTION_ID_MAX_LENGTH + 1)}`],
      },
    ],
    ['a control character', { ...FILE, released: ['demo:1\n'] }],
    ['a number for a key', { ...FILE, released: [1] }],
    [
      'one session assigned twice',
      {
        ...FILE,
        assignments: [ASSIGNMENT, { ...ASSIGNMENT, actorId: 'another' }],
      },
    ],
    [
      'one actor id twice',
      {
        ...FILE,
        assignments: [ASSIGNMENT, { ...ASSIGNMENT, sessionKey: 'demo:1' }],
      },
    ],
    [
      'an assignment of an unknown source',
      { ...FILE, assignments: [{ ...ASSIGNMENT, sessionKey: 'vim:1' }] },
    ],
    [
      'an assignment with a __proto__ actor id',
      { ...FILE, assignments: [{ ...ASSIGNMENT, actorId: '__proto__' }] },
    ],
    [
      'an assignment with no character',
      {
        ...FILE,
        assignments: [{ sessionKey: CLAUDE_KEY, actorId: 'a1' }],
      },
    ],
    ['an unknown field', { ...FILE, actors: {} }],
    ['a list', [FILE]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(poolFileSchema, value);
  });
});

describe('poolAssignmentSchema', () => {
  it('round-trips an assignment', () => {
    expectRoundTrip(poolAssignmentSchema, ASSIGNMENT);
  });

  it.each([
    ['an empty actor id', { ...ASSIGNMENT, actorId: '' }],
    [
      'an actor id past the limit',
      { ...ASSIGNMENT, actorId: 'x'.repeat(ACTOR_ID_MAX_LENGTH + 1) },
    ],
    ['a __proto__ actor id', { ...ASSIGNMENT, actorId: '__proto__' }],
    ['a character key with no pack', { ...ASSIGNMENT, characterKey: 'a' }],
    [
      'a character key with three parts',
      { ...ASSIGNMENT, characterKey: 'sample-pack/probe-a/x' },
    ],
    [
      'an uppercase character id',
      { ...ASSIGNMENT, characterKey: 'sample-pack/Probe' },
    ],
    ['a bad session key', { ...ASSIGNMENT, sessionKey: 'demo' }],
    ['an extra field', { ...ASSIGNMENT, state: 'idle' }],
  ])('rejects %s', (_label, value) => {
    expectRejected(poolAssignmentSchema, value);
  });
});

describe('stagePoolSchema (StageView pool section)', () => {
  const NONE = { released: [], locked: [], lockOn: false };

  it.each([
    ['nothing released', NONE],
    ['one key', { ...NONE, released: ['demo:1'] }],
    [
      'sorted keys',
      { ...NONE, released: ['claude-code:x', 'codex:a', 'demo:1'] },
    ],
    [
      'locked keys, 鎖定展示 off',
      { ...NONE, locked: ['claude-code:x', 'demo:1'] },
    ],
    [
      'a key released and locked, 鎖定展示 on',
      { released: ['demo:1'], locked: ['demo:1'], lockOn: true },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stagePoolSchema, value);
  });

  it.each([
    ['keys out of order', { ...NONE, released: ['demo:1', 'codex:a'] }],
    ['a key twice', { ...NONE, released: ['demo:1', 'demo:1'] }],
    ['a bad key', { ...NONE, released: ['demo'] }],
    ['locked keys out of order', { ...NONE, locked: ['demo:1', 'codex:a'] }],
    ['a locked key twice', { ...NONE, locked: ['demo:1', 'demo:1'] }],
    ['鎖定展示 on with nothing locked', { ...NONE, lockOn: true }],
    ['no list', {}],
    ['no locked list or lockOn', { released: [] }],
    ['an extra field', { ...NONE, actors: [] }],
    ['a bare list', ['demo:1']],
  ])('rejects %s', (_label, value) => {
    expectRejected(stagePoolSchema, value);
  });
});

describe('heldBackBy (who gets no character)', () => {
  const KEYS = ['codex:a', 'codex:b', 'demo:1'] as const;

  it.each([
    [
      '鎖定展示 off: the released ones',
      { released: ['codex:a'], locked: ['codex:b'], lockOn: false },
      [true, false, false],
    ],
    [
      '鎖定展示 on: every one not locked, released or not',
      { released: ['codex:a'], locked: ['codex:a'], lockOn: true },
      [false, true, true],
    ],
  ] as const)('%s', (_label, pool, expected) => {
    const heldBack = heldBackBy({
      released: [...pool.released],
      locked: [...pool.locked],
      lockOn: pool.lockOn,
    });
    expect(KEYS.map((key) => heldBack(key))).toStrictEqual(expected);
  });
});

describe('stageActorsSchema (StageView actors section, Story 3.4)', () => {
  const ACTOR = {
    actorId: ASSIGNMENT.actorId,
    sessionKey: CLAUDE_KEY,
    characterKey: ASSIGNMENT.characterKey,
    state: 'working',
    confidence: 'exact',
    displayName: 'gundam-pet',
  };
  const DEMO_ACTOR = {
    actorId: 'a2',
    sessionKey: 'demo:1',
    characterKey: ASSIGNMENT.characterKey,
    state: 'approval',
    confidence: 'inferred',
    displayName: null,
  };

  it.each([
    ['no actor', []],
    ['one actor', [ACTOR]],
    ['two actors playing one character', [ACTOR, DEMO_ACTOR]],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageActorsSchema, value);
  });

  it.each([
    [
      'two actors with one actor id',
      [ACTOR, { ...DEMO_ACTOR, actorId: ACTOR.actorId }],
    ],
    ['two actors of one session', [ACTOR, { ...ACTOR, actorId: 'a3' }]],
    ['not a list', ACTOR],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageActorsSchema, value);
  });

  it.each([
    ['a __proto__ actor id', { ...ACTOR, actorId: '__proto__' }],
    ['an unknown state', { ...ACTOR, state: 'sleeping' }],
    ['an unknown confidence', { ...ACTOR, confidence: 'maybe' }],
    ['an empty display name', { ...ACTOR, displayName: '' }],
    [
      'a display name past the limit',
      { ...ACTOR, displayName: 'x'.repeat(DETECTION_ID_MAX_LENGTH + 1) },
    ],
    ['no display name', { ...ACTOR, displayName: undefined }],
    ['a bad character key', { ...ACTOR, characterKey: 'probe-a' }],
    ['the session source (packs never see it)', { ...ACTOR, source: 'codex' }],
  ])('rejects an actor with %s', (_label, value) => {
    expectRejected(stageActorSchema, value);
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

describe('poolSetReleasedManyInputSchema (session bulk-lock)', () => {
  const keys = (count: number) =>
    Array.from({ length: count }, (_, i) => `demo:${i}`);

  it.each([
    ['release one', [['demo:1'], true]],
    [
      'show several again, one repeated',
      [['codex:a', 'demo:1', 'demo:1'], false],
    ],
    ['exactly the limit', [keys(POOL_SET_RELEASED_MANY_MAX_KEYS), true]],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(poolSetReleasedManyInputSchema, value);
  });

  it.each([
    ['no keys', [[], true]],
    ['one past the limit', [keys(POOL_SET_RELEASED_MANY_MAX_KEYS + 1), true]],
    ['a bad key', [['demo:1', 'vim:1'], true]],
    ['a key, not a list', ['demo:1', true]],
    ['no flag', [['demo:1']]],
    ['an extra argument', [['demo:1'], true, true]],
  ])('rejects %s', (_label, value) => {
    expectRejected(poolSetReleasedManyInputSchema, value);
  });
});

describe('poolSetLockedInputSchema and poolSetLockOnInputSchema (session bulk-lock)', () => {
  it.each([
    [poolSetLockedInputSchema, ['demo:1', true]],
    [poolSetLockedInputSchema, ['codex:a', false]],
    [poolSetLockOnInputSchema, [true]],
    [poolSetLockOnInputSchema, [false]],
  ])('round-trips %#', (schema, value) => {
    expectRoundTrip(schema, value);
  });

  it.each([
    [poolSetLockedInputSchema, ['vim:1', true]],
    [poolSetLockedInputSchema, ['demo:1']],
    [poolSetLockedInputSchema, ['demo:1', 'true']],
    [poolSetLockOnInputSchema, []],
    [poolSetLockOnInputSchema, ['on']],
    [poolSetLockOnInputSchema, [true, true]],
  ])('rejects %#', (schema, value) => {
    expectRejected(schema, value);
  });
});
