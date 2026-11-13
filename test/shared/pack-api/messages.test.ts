import { describe, expect, it } from 'vitest';
import {
  ACTOR_ID_MAX_LENGTH,
  actorIdSchema,
  despawnMessageSchema,
  displayNameSchema,
  enterEventSchema,
  frameActorSchema,
  frameEventSchema,
  frameMessageSchema,
  initMessageSchema,
  leaveEventSchema,
  metaMessageSchema,
  otherActorSchema,
  ownActorSchema,
  paramsMessageSchema,
  spawnMessageSchema,
  STAGE_MESSAGE_TYPES,
  stageMessageSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { expectRuleIssue } from './issues';
import { changed, removed } from './samples';

const PARAMS = { 'blink-every': 6, sway: 0.3, mood: 'calm', skin: 'body-dots' };

/** A valid sample of each message the stage sends, by type. */
const MESSAGES = {
  init: {
    type: 'init',
    actors: [
      {
        own: true,
        actorId: 'a1',
        characterId: 'probe-b',
        params: PARAMS,
        state: 'working',
        displayName: 'refactor parser',
      },
      { own: false, actorId: 'a2', state: 'idle' },
      {
        own: true,
        actorId: 'a3',
        characterId: 'probe-b',
        params: PARAMS,
        state: 'waiting',
        displayName: null,
      },
    ],
  },
  spawn: {
    type: 'spawn',
    actorId: 'a4',
    characterId: 'probe-a',
    params: { glow: false },
    state: 'thinking',
    displayName: 'docs',
  },
  despawn: { type: 'despawn', actorId: 'a4' },
  params: { type: 'params', characterId: 'probe-b', params: PARAMS },
  meta: { type: 'meta', actorId: 'a1', displayName: 'parser 修正' },
  frame: {
    type: 'frame',
    seq: 42,
    t: 1400.5,
    dt: 33.3,
    actors: [
      { actorId: 'a1', state: 'working' },
      { actorId: 'a3', state: 'waiting' },
    ],
    events: [
      { type: 'enter', actorId: 'a5' },
      { type: 'leave', actorId: 'a2' },
    ],
  },
} as const;

const SCHEMAS = {
  init: initMessageSchema,
  spawn: spawnMessageSchema,
  despawn: despawnMessageSchema,
  params: paramsMessageSchema,
  meta: metaMessageSchema,
  frame: frameMessageSchema,
};

const TYPES = Object.keys(MESSAGES) as (keyof typeof MESSAGES)[];

describe('I/O matrix', () => {
  it.each(TYPES)(
    '訊息與 draw: a valid %s round-trips, alone and as a stage message',
    (type) => {
      expectRoundTrip(SCHEMAS[type], MESSAGES[type]);
      expectRoundTrip(stageMessageSchema, MESSAGES[type]);
    },
  );

  it.each(['hello', 'draw', 'ping', 'fire', 'hold', 'face', 'log', ''])(
    '訊息與 draw: a stage message of unknown type %o is rejected',
    (type) => {
      expectRejected(
        stageMessageSchema,
        changed(MESSAGES.meta, ['type'], type),
      );
    },
  );

  it.each(TYPES)(
    '訊息與 draw: a %s with an extra field is rejected',
    (type) => {
      const extra = changed(MESSAGES[type], ['sessionKey'], 'demo:1');
      expectRejected(SCHEMAS[type], extra);
      expectRejected(stageMessageSchema, extra);
    },
  );
});

describe('stage messages', () => {
  it('has the six types, one per message schema, each with a sample', () => {
    expect([...STAGE_MESSAGE_TYPES]).toStrictEqual(TYPES);
    expect(
      stageMessageSchema.options.map((option) => option.shape.type.value),
    ).toStrictEqual([...STAGE_MESSAGE_TYPES]);
  });

  it.each([
    ['an init lists', MESSAGES.init, ['actors', 2, 'actorId'], 'a1'],
    ['a frame lists', MESSAGES.frame, ['actors', 1, 'actorId'], 'a1'],
    [
      'an init lists another pack’s',
      MESSAGES.init,
      ['actors', 2],
      { own: false, actorId: 'a2', state: 'error' },
    ],
  ] as const)(
    'rejects an actor that %s twice as duplicate-actor-id',
    (_label, message, path, value) => {
      expectRuleIssue(
        stageMessageSchema,
        changed(message, path, value),
        'duplicate-actor-id',
        ['actors'],
      );
    },
  );

  it.each([
    ['an init with no actors', { type: 'init', actors: [] }],
    [
      'a frame with no actors or events, at time 0',
      { type: 'frame', seq: 0, t: 0, dt: 0, actors: [], events: [] },
    ],
    [
      'params with no values',
      { type: 'params', characterId: 'ab', params: {} },
    ],
    [
      'the longest actor id',
      changed(MESSAGES.despawn, ['actorId'], 'x'.repeat(ACTOR_ID_MAX_LENGTH)),
    ],
    [
      'an actor id that is not an id',
      changed(MESSAGES.despawn, ['actorId'], 'Actor #1 / 甲'),
    ],
    ['an empty display name', changed(MESSAGES.meta, ['displayName'], '')],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageMessageSchema, value);
  });

  it.each<[string, unknown]>([
    [
      'an own actor without its character',
      changed(MESSAGES.init, ['actors', 0], {
        own: true,
        actorId: 'a1',
        state: 'idle',
      }),
    ],
    [
      'another pack’s actor with a character',
      changed(MESSAGES.init, ['actors', 1, 'characterId'], 'probe-a'),
    ],
    [
      'another pack’s actor with a display name',
      changed(MESSAGES.init, ['actors', 1, 'displayName'], null),
    ],
    [
      'an init actor with no own flag',
      removed(MESSAGES.init, ['actors', 1, 'own']),
    ],
    [
      'an init actor with own as a string',
      changed(MESSAGES.init, ['actors', 1, 'own'], 'false'),
    ],
    ['an empty actor id', changed(MESSAGES.despawn, ['actorId'], '')],
    [
      'an actor id past the limit',
      changed(
        MESSAGES.despawn,
        ['actorId'],
        'x'.repeat(ACTOR_ID_MAX_LENGTH + 1),
      ),
    ],
    ['a number for an actor id', changed(MESSAGES.despawn, ['actorId'], 1)],
    ['a bad character id', changed(MESSAGES.spawn, ['characterId'], 'Probe')],
    ['an unknown state', changed(MESSAGES.spawn, ['state'], 'sleeping')],
    ['a missing display name', removed(MESSAGES.spawn, ['displayName'])],
    [
      'a null parameter value',
      changed(MESSAGES.spawn, ['params', 'glow'], null),
    ],
    ['a bad parameter key', changed(MESSAGES.params, ['params', 'Glow'], true)],
    ['a meta with no actor', removed(MESSAGES.meta, ['actorId'])],
    ['a negative seq', changed(MESSAGES.frame, ['seq'], -1)],
    ['a fractional seq', changed(MESSAGES.frame, ['seq'], 1.5)],
    ['a negative t', changed(MESSAGES.frame, ['t'], -1)],
    ['an infinite t', changed(MESSAGES.frame, ['t'], Infinity)],
    ['a NaN dt', changed(MESSAGES.frame, ['dt'], Number.NaN)],
    ['no events', removed(MESSAGES.frame, ['events'])],
    [
      'a motion field on a frame actor (API 1.1)',
      changed(MESSAGES.frame, ['actors', 0, 'motion'], { vx: 1 }),
    ],
    [
      'a frame actor with no state',
      removed(MESSAGES.frame, ['actors', 0, 'state']),
    ],
    [
      'an event of a later API',
      changed(MESSAGES.frame, ['events', 0], { type: 'near', actorId: 'a5' }),
    ],
    [
      'an event with an extra field',
      changed(MESSAGES.frame, ['events', 0, 'state'], 'idle'),
    ],
    ['no type', removed(MESSAGES.despawn, ['type'])],
    ['a list', [MESSAGES.despawn]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageMessageSchema, value);
  });
});

describe('actorIdSchema and displayNameSchema', () => {
  it('an actor id is 1 to 64 characters of anything', () => {
    expectRoundTrip(actorIdSchema, 'a');
    expectRejected(actorIdSchema, '');
    expectRejected(actorIdSchema, 'x'.repeat(65));
  });

  it('a display name is a string or null', () => {
    expectRoundTrip(displayNameSchema, 'docs');
    expectRoundTrip(displayNameSchema, null);
    expectRejected(displayNameSchema, undefined);
    expectRejected(displayNameSchema, 1);
  });
});

describe('init actors', () => {
  const [OWN, OTHER] = MESSAGES.init.actors;

  it('round-trips one of this pack’s actors and another pack’s', () => {
    expectRoundTrip(ownActorSchema, OWN);
    expectRoundTrip(otherActorSchema, OTHER);
  });

  it.each([
    ['own false', changed(OWN, ['own'], false)],
    ['no params', removed(OWN, ['params'])],
    ['no display name', removed(OWN, ['displayName'])],
    ['a bad character id', changed(OWN, ['characterId'], 'B')],
    ['an extra field', changed(OWN, ['sessionKey'], 'demo:1')],
  ])('one of this pack’s actors rejects %s', (_label, value) => {
    expectRejected(ownActorSchema, value);
  });

  it.each([
    ['own true', changed(OTHER, ['own'], true)],
    ['a character id', changed(OTHER, ['characterId'], 'probe-a')],
    ['an unknown state', changed(OTHER, ['state'], 'sleeping')],
    ['no actor id', removed(OTHER, ['actorId'])],
  ])('another pack’s actor rejects %s', (_label, value) => {
    expectRejected(otherActorSchema, value);
  });
});

describe('frame actors', () => {
  it('round-trips an actor and its state', () => {
    expectRoundTrip(frameActorSchema, { actorId: 'a1', state: 'done' });
  });

  it.each([
    ['no state', { actorId: 'a1' }],
    ['an unknown state', { actorId: 'a1', state: 'sleeping' }],
    ['an empty actor id', { actorId: '', state: 'done' }],
    ['motion (API 1.1)', { actorId: 'a1', state: 'done', motion: {} }],
  ])('rejects %s', (_label, value) => {
    expectRejected(frameActorSchema, value);
  });
});

describe('frameEventSchema', () => {
  it('enter and leave each round-trip alone', () => {
    expectRoundTrip(enterEventSchema, { type: 'enter', actorId: 'a1' });
    expectRoundTrip(leaveEventSchema, { type: 'leave', actorId: 'a1' });
  });

  it.each([
    ['enter', enterEventSchema, { type: 'leave', actorId: 'a1' }],
    ['enter', enterEventSchema, { type: 'enter', actorId: '' }],
    ['enter', enterEventSchema, { type: 'enter', actorId: 'a1', x: 0 }],
    ['leave', leaveEventSchema, { type: 'enter', actorId: 'a1' }],
    ['leave', leaveEventSchema, { type: 'leave' }],
    ['leave', leaveEventSchema, { type: 'leave', actorId: 'a1', x: 0 }],
  ])('%s rejects %o', (_label, schema, value) => {
    expectRejected(schema, value);
  });

  it.each([
    { type: 'enter', actorId: 'a1' },
    { type: 'leave', actorId: 'a1' },
  ])('round-trips %o', (value) => {
    expectRoundTrip(frameEventSchema, value);
  });

  it.each([
    ['motion (API 1.1)', { type: 'motion', actorId: 'a1' }],
    ['no actor', { type: 'enter' }],
    ['an extra field', { type: 'leave', actorId: 'a1', x: 0 }],
  ])('rejects %s', (_label, value) => {
    expectRejected(frameEventSchema, value);
  });
});
