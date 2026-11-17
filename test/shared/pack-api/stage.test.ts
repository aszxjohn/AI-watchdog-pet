import { describe, expect, it } from 'vitest';
import {
  FACE_DIRECTIONS,
  STAGE_CALL_TYPES,
  stageCallSchema,
  stageFaceCallSchema,
  stageFireCallSchema,
  stageHoldCallSchema,
  stageLogCallSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';

/** A valid sample of each `stage.*` call, by type. */
const CALLS = {
  'stage.log': { type: 'stage.log', text: 'hello\nthere' },
  'stage.fire': {
    type: 'stage.fire',
    actorId: 'a1',
    target: 'a2',
    object: 'spark',
  },
  'stage.hold': { type: 'stage.hold', actorId: 'a1', on: true },
  'stage.face': { type: 'stage.face', actorId: 'a1', direction: 'left' },
} as const;

describe('stage.* calls (Story 3.5)', () => {
  it('lists the four calls a pack sends as messages', () => {
    expect(STAGE_CALL_TYPES).toStrictEqual(Object.keys(CALLS));
    expect(FACE_DIRECTIONS).toStrictEqual(['left', 'right']);
  });

  it.each(Object.entries(CALLS))('round-trips %s', (_type, call) => {
    expectRoundTrip(stageCallSchema, call);
  });

  it('each call has its own schema', () => {
    expectRoundTrip(stageLogCallSchema, CALLS['stage.log']);
    expectRoundTrip(stageFireCallSchema, CALLS['stage.fire']);
    expectRoundTrip(stageHoldCallSchema, CALLS['stage.hold']);
    expectRoundTrip(stageFaceCallSchema, CALLS['stage.face']);
    expectRoundTrip(stageLogCallSchema, { type: 'stage.log', text: '' });
  });

  it.each<[string, unknown]>([
    ['no type', { text: 'x' }],
    ['an unknown type', { type: 'stage.random', actorId: 'a1' }],
    ['a draw', { type: 'draw', seq: 0, actors: {} }],
    ['an extra field', { ...CALLS['stage.log'], level: 'warn' }],
    ['a text that is not a string', { type: 'stage.log', text: 1 }],
    ['an empty actor id', { ...CALLS['stage.hold'], actorId: '' }],
    [
      '__proto__ as the actor',
      { ...CALLS['stage.hold'], actorId: '__proto__' },
    ],
    [
      'an actor id over 64',
      { ...CALLS['stage.hold'], actorId: 'a'.repeat(65) },
    ],
    ['a hold that is not a boolean', { ...CALLS['stage.hold'], on: 1 }],
    ['an unknown direction', { ...CALLS['stage.face'], direction: 'up' }],
    ['a fire without a target', { ...CALLS['stage.fire'], target: undefined }],
    [
      'a projectile key that is not an id',
      { ...CALLS['stage.fire'], object: 'A B' },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageCallSchema, value);
  });
});
