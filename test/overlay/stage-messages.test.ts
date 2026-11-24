/**
 * pack-host's stage messages (Story 3.6): what one pack is sent at each
 * tick, from what it was sent before (composeTick). Every message is also
 * checked against the pack API's stageMessageSchema and for what a pack
 * must never see.
 */
import { describe, expect, it } from 'vitest';
import { FRAME_EVENTS_MAX } from '../../src/shared/constants';
import {
  composeTick,
  newPackStageState,
  type PackStageState,
  type PackTickInput,
} from '../../src/overlay/pack-host/stage-messages';
import {
  type FrameEvent,
  manifestSchema,
  type PackCharacter,
  type StageMessage,
  stageMessageSchema,
} from '../../src/shared/pack-api';
import type { StageActor } from '../../src/shared/pool';
import type {
  StageCharacter,
  StageCharacters,
} from '../../src/shared/stage-view';
import { contractManifest } from '../helpers/awpet';

const PACK = 'contract-pack';
const OTHER = 'other-pack';
const MANIFEST = manifestSchema.parse(contractManifest());

function character(characterId: string): PackCharacter | undefined {
  return MANIFEST.characters.find((each) => each.id === characterId);
}

const FIXED: StageCharacter['fixed'] = {
  scale: 1,
  inPool: true,
  badges: true,
  wander: {
    enabled: true,
    activity: 'medium',
    speed: 'medium',
    areas: [6, 7, 8],
  },
};

const ONE_PARAMS = { glow: true, bob: 2, skin: 'probe-one-plain' };
const TWO_PARAMS = { 'blink-every': 3, mood: 'calm' };

const CHARACTERS: StageCharacters = {
  [`${PACK}/probe-one`]: { params: ONE_PARAMS, fixed: FIXED },
  [`${PACK}/probe-two`]: {
    params: TWO_PARAMS,
    fixed: { ...FIXED, scale: 0.9 },
  },
};

function actor(
  actorId: string,
  characterKey: `${string}/${string}`,
  state: StageActor['state'] = 'working',
  displayName: string | null = `name ${actorId}`,
): Pick<StageActor, 'actorId' | 'characterKey' | 'state' | 'displayName'> {
  return { actorId, characterKey, state, displayName };
}

function input(
  actors: PackTickInput['actors'],
  options: {
    t?: number;
    events?: readonly FrameEvent[];
    characters?: StageCharacters;
  } = {},
): PackTickInput {
  return {
    packId: PACK,
    actors,
    characters: options.characters ?? CHARACTERS,
    character,
    t: options.t ?? 0,
    events: options.events ?? [],
  };
}

/** composeTick, checking each message against the shared schema. */
function tick(state: PackStageState, tickInput: PackTickInput): StageMessage[] {
  const messages = composeTick(state, tickInput);
  for (const message of messages) {
    expect(stageMessageSchema.parse(structuredClone(message))).toStrictEqual(
      message,
    );
  }
  return messages;
}

/** Answers the frame in flight, as a draw would. */
function answer(state: PackStageState): void {
  state.inFlight = null;
}

const FORBIDDEN = [
  'sessionKey',
  'source',
  'confidence',
  'motion',
  'fixed',
  'scale',
  'inPool',
  'badges',
  'wander',
  'characterKey',
];

/** Every key anywhere in `value`. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysIn);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [
      key,
      ...keysIn(inner),
    ]);
  }
  return [];
}

describe('I/O matrix', () => {
  it('出現: the first tick sends init (own actor with characterId, full params, mapped state, display name; another pack’s with id and state only), then a frame', () => {
    const state = newPackStageState();

    const messages = tick(
      state,
      input(
        [
          actor('b1', `${OTHER}/someone`, 'approval'),
          actor('a1', `${PACK}/probe-one`, 'done', 'project'),
        ],
        { t: 500, events: [{ type: 'enter', actorId: 'a1' }] },
      ),
    );

    expect(messages).toStrictEqual([
      {
        type: 'init',
        actors: [
          { own: false, actorId: 'b1', state: 'approval' },
          {
            own: true,
            actorId: 'a1',
            characterId: 'probe-one',
            params: ONE_PARAMS,
            state: 'waiting',
            displayName: 'project',
          },
        ],
      },
      {
        type: 'frame',
        seq: 0,
        t: 500,
        dt: 0,
        actors: [{ actorId: 'a1', state: 'waiting' }],
        events: [],
      },
    ]);
    expect(state.inFlight).toStrictEqual({ seq: 0, actors: new Set(['a1']) });
  });

  it('出現: every later tick sends one frame, seq counting up, dt since the previous frame', () => {
    const state = newPackStageState();
    const actors = [actor('a1', `${PACK}/probe-one`)];
    tick(state, input(actors, { t: 0 }));
    answer(state);

    expect(tick(state, input(actors, { t: 33 }))).toStrictEqual([
      {
        type: 'frame',
        seq: 1,
        t: 33,
        dt: 33,
        actors: [{ actorId: 'a1', state: 'working' }],
        events: [],
      },
    ]);
    answer(state);
    expect(tick(state, input(actors, { t: 70 }))).toMatchObject([
      { type: 'frame', seq: 2, dt: 37 },
    ]);
  });

  it('加入與移出: a new own actor gets spawn (params, state, name) and the enter event; one leaving gets despawn and leave', () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-one`)]));
    answer(state);

    const joined = tick(
      state,
      input(
        [
          actor('a1', `${PACK}/probe-one`),
          actor('a2', `${PACK}/probe-two`, 'thinking', null),
        ],
        { t: 33, events: [{ type: 'enter', actorId: 'a2' }] },
      ),
    );
    expect(joined).toStrictEqual([
      {
        type: 'spawn',
        actorId: 'a2',
        characterId: 'probe-two',
        params: TWO_PARAMS,
        state: 'working',
        displayName: null,
      },
      {
        type: 'frame',
        seq: 1,
        t: 33,
        dt: 33,
        actors: [
          { actorId: 'a1', state: 'working' },
          { actorId: 'a2', state: 'working' },
        ],
        events: [{ type: 'enter', actorId: 'a2' }],
      },
    ]);
    answer(state);

    const left = tick(
      state,
      input([actor('a2', `${PACK}/probe-two`, 'thinking', null)], {
        t: 66,
        events: [{ type: 'leave', actorId: 'a1' }],
      }),
    );
    expect(left).toStrictEqual([
      { type: 'despawn', actorId: 'a1' },
      {
        type: 'frame',
        seq: 2,
        t: 66,
        dt: 33,
        actors: [{ actorId: 'a2', state: 'working' }],
        events: [{ type: 'leave', actorId: 'a1' }],
      },
    ]);
  });

  it('加入與移出: the last own actor leaving gets its despawn and one more frame, with no actors, carrying its leave; then no frame and no event kept until an own actor comes back', () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-one`)]));
    answer(state);

    expect(
      tick(
        state,
        input([actor('b1', `${OTHER}/someone`)], {
          t: 33,
          events: [
            { type: 'enter', actorId: 'b1' },
            { type: 'leave', actorId: 'a1' },
          ],
        }),
      ),
    ).toStrictEqual([
      { type: 'despawn', actorId: 'a1' },
      {
        type: 'frame',
        seq: 1,
        t: 33,
        dt: 33,
        actors: [],
        events: [
          { type: 'enter', actorId: 'b1' },
          { type: 'leave', actorId: 'a1' },
        ],
      },
    ]);
    answer(state);
    expect(
      tick(
        state,
        input([], { t: 66, events: [{ type: 'leave', actorId: 'b1' }] }),
      ),
    ).toStrictEqual([]);
    expect(state.events).toStrictEqual([]);

    const back = tick(
      state,
      input([actor('a2', `${PACK}/probe-one`)], {
        t: 100,
        events: [{ type: 'enter', actorId: 'a2' }],
      }),
    );
    expect(back.map((message) => message.type)).toStrictEqual([
      'spawn',
      'frame',
    ]);
    expect(back[1]).toMatchObject({
      seq: 2,
      dt: 67,
      events: [{ type: 'enter', actorId: 'a2' }],
    });
  });

  it('加入與移出: the last own actor leaving while a frame is unanswered: the frame with its leave comes once that one is answered', () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-one`)]));

    expect(
      tick(
        state,
        input([], { t: 33, events: [{ type: 'leave', actorId: 'a1' }] }),
      ),
    ).toStrictEqual([{ type: 'despawn', actorId: 'a1' }]);
    answer(state);
    expect(tick(state, input([], { t: 66 }))).toStrictEqual([
      {
        type: 'frame',
        seq: 1,
        t: 66,
        dt: 66,
        actors: [],
        events: [{ type: 'leave', actorId: 'a1' }],
      },
    ]);
    answer(state);
    expect(tick(state, input([], { t: 100 }))).toStrictEqual([]);
  });

  it(`在途: a frame left unanswered keeps only the latest ${FRAME_EVENTS_MAX} events`, () => {
    const state = newPackStageState();
    const actors = [actor('a1', `${PACK}/probe-one`)];
    tick(state, input(actors));
    for (let i = 0; i < FRAME_EVENTS_MAX + 10; i += 1) {
      tick(
        state,
        input(actors, { events: [{ type: 'enter', actorId: `x${i}` }] }),
      );
    }
    answer(state);

    const [frame] = tick(state, input(actors));
    const events = frame?.type === 'frame' ? frame.events : [];
    expect(events).toHaveLength(FRAME_EVENTS_MAX);
    expect(events[0]).toStrictEqual({ type: 'enter', actorId: 'x10' });
    expect(events.at(-1)).toStrictEqual({
      type: 'enter',
      actorId: `x${FRAME_EVENTS_MAX + 9}`,
    });
  });

  it("加入與移出: another pack's actors are only events, never spawned", () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-one`)]));
    answer(state);

    const messages = tick(
      state,
      input(
        [actor('a1', `${PACK}/probe-one`), actor('b1', `${OTHER}/someone`)],
        { events: [{ type: 'enter', actorId: 'b1' }] },
      ),
    );
    expect(messages.map((message) => message.type)).toStrictEqual(['frame']);
    expect(messages[0]).toMatchObject({
      events: [{ type: 'enter', actorId: 'b1' }],
    });
  });

  it('狀態改變: the next frame carries the new state, mapped through fallback', () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-two`, 'working')]));
    answer(state);

    expect(
      tick(state, input([actor('a1', `${PACK}/probe-two`, 'thinking')])),
    ).toMatchObject([
      { type: 'frame', actors: [{ actorId: 'a1', state: 'working' }] },
    ]);
    answer(state);
    expect(
      tick(state, input([actor('a1', `${PACK}/probe-two`, 'error')])),
    ).toMatchObject([
      { type: 'frame', actors: [{ actorId: 'a1', state: 'error' }] },
    ]);
  });

  it('狀態對應不到: a state in neither states nor fallback goes to the pack as it is', () => {
    const state = newPackStageState();
    const messages = tick(
      state,
      input([actor('a1', `${PACK}/probe-one`, 'approval')]),
    );
    expect(messages[0]).toMatchObject({
      actors: [{ own: true, actorId: 'a1', state: 'approval' }],
    });
    expect(messages[1]).toMatchObject({
      actors: [{ actorId: 'a1', state: 'approval' }],
    });
  });

  it('fallback: with the contract pack’s manifest, probe-one’s done and waiting both go to the pack as waiting, and probe-two’s waiting as done, in init and frame', () => {
    const state = newPackStageState();

    const messages = tick(
      state,
      input([
        actor('a1', `${PACK}/probe-one`, 'done'),
        actor('a2', `${PACK}/probe-one`, 'waiting'),
        actor('a3', `${PACK}/probe-two`, 'waiting'),
      ]),
    );

    expect(messages).toMatchObject([
      {
        type: 'init',
        actors: [
          {
            own: true,
            actorId: 'a1',
            characterId: 'probe-one',
            state: 'waiting',
          },
          {
            own: true,
            actorId: 'a2',
            characterId: 'probe-one',
            state: 'waiting',
          },
          { own: true, actorId: 'a3', characterId: 'probe-two', state: 'done' },
        ],
      },
      {
        type: 'frame',
        actors: [
          { actorId: 'a1', state: 'waiting' },
          { actorId: 'a2', state: 'waiting' },
          { actorId: 'a3', state: 'done' },
        ],
      },
    ]);
  });

  it('佔位: with the contract pack’s manifest, a state in neither states nor fallback (probe-one’s error and decision, probe-two’s idle) goes to the pack as it is, in init, spawn and frame; probe-two’s error, which it draws, as it is too', () => {
    const state = newPackStageState();
    const first = tick(
      state,
      input([actor('a1', `${PACK}/probe-one`, 'error')]),
    );
    expect(first).toMatchObject([
      { type: 'init', actors: [{ own: true, actorId: 'a1', state: 'error' }] },
      { type: 'frame', actors: [{ actorId: 'a1', state: 'error' }] },
    ]);
    answer(state);

    const joined = tick(
      state,
      input([
        actor('a1', `${PACK}/probe-one`, 'error'),
        actor('a2', `${PACK}/probe-one`, 'decision'),
        actor('a3', `${PACK}/probe-two`, 'idle'),
        actor('a4', `${PACK}/probe-two`, 'error'),
      ]),
    );

    expect(joined).toMatchObject([
      { type: 'spawn', actorId: 'a2', state: 'decision' },
      { type: 'spawn', actorId: 'a3', state: 'idle' },
      { type: 'spawn', actorId: 'a4', state: 'error' },
      {
        type: 'frame',
        actors: [
          { actorId: 'a1', state: 'error' },
          { actorId: 'a2', state: 'decision' },
          { actorId: 'a3', state: 'idle' },
          { actorId: 'a4', state: 'error' },
        ],
      },
    ]);
  });

  it('狀態變回: into the placeholder and back, the pack gets a frame every tick, with the state as it is while in the placeholder and mapped again after', () => {
    const state = newPackStageState();
    const states: string[] = [];
    for (const each of ['working', 'approval', 'done'] as const) {
      const messages = tick(
        state,
        input([actor('a1', `${PACK}/probe-one`, each)]),
      );
      const frame = messages.find((message) => message.type === 'frame');
      expect(frame).toBeDefined();
      if (frame?.type === 'frame') {
        states.push(...frame.actors.map((one) => one.state));
      }
      answer(state);
    }

    expect(states).toStrictEqual(['working', 'approval', 'waiting']);
  });

  it('參數與名稱: a character whose params changed gets one params that tick, however many actors play it; a changed name gets meta', () => {
    const state = newPackStageState();
    const actors = [
      actor('a1', `${PACK}/probe-one`),
      actor('a2', `${PACK}/probe-one`),
      actor('a3', `${PACK}/probe-two`),
    ];
    tick(state, input(actors));
    answer(state);
    const changed = { glow: false, bob: 4, skin: 'probe-one-dots' };

    const messages = tick(
      state,
      input(
        [
          actor('a1', `${PACK}/probe-one`),
          actor('a2', `${PACK}/probe-one`, 'working', 'renamed'),
          actor('a3', `${PACK}/probe-two`),
        ],
        {
          characters: {
            ...CHARACTERS,
            [`${PACK}/probe-one`]: { params: changed, fixed: FIXED },
          },
        },
      ),
    );

    expect(messages.slice(0, -1)).toStrictEqual([
      { type: 'params', characterId: 'probe-one', params: changed },
      { type: 'meta', actorId: 'a2', displayName: 'renamed' },
    ]);
    answer(state);
    // Nothing changed since: only a frame.
    expect(
      tick(
        state,
        input(
          [
            actor('a1', `${PACK}/probe-one`),
            actor('a2', `${PACK}/probe-one`, 'working', 'renamed'),
            actor('a3', `${PACK}/probe-two`),
          ],
          {
            characters: {
              ...CHARACTERS,
              [`${PACK}/probe-one`]: { params: changed, fixed: FIXED },
            },
          },
        ),
      ).map((message) => message.type),
    ).toStrictEqual(['frame']);
  });

  it('參數與名稱: a new actor of a character whose params changed carries them in its spawn; no params for a character with no actor sent', () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-one`)]));
    answer(state);
    const changed = { 'blink-every': 5, mood: 'busy' };

    const messages = tick(
      state,
      input(
        [actor('a1', `${PACK}/probe-one`), actor('a2', `${PACK}/probe-two`)],
        {
          characters: {
            ...CHARACTERS,
            [`${PACK}/probe-two`]: { params: changed, fixed: FIXED },
          },
        },
      ),
    );
    expect(messages.map((message) => message.type)).toStrictEqual([
      'spawn',
      'frame',
    ]);
    expect(messages[0]).toMatchObject({ params: changed });
  });

  it('在途: while the previous frame is unanswered, a tick sends no frame (no queue), only the other messages; no event is lost', () => {
    const state = newPackStageState();
    tick(state, input([actor('a1', `${PACK}/probe-one`)], { t: 0 }));

    const skipped = tick(
      state,
      input([actor('a1', `${PACK}/probe-one`, 'working', 'renamed')], {
        t: 33,
        events: [{ type: 'enter', actorId: 'b1' }],
      }),
    );
    expect(skipped).toStrictEqual([
      { type: 'meta', actorId: 'a1', displayName: 'renamed' },
    ]);
    expect(
      tick(
        state,
        input([actor('a1', `${PACK}/probe-one`, 'working', 'renamed')], {
          t: 66,
          events: [{ type: 'leave', actorId: 'b1' }],
        }),
      ),
    ).toStrictEqual([]);

    answer(state);
    expect(
      tick(
        state,
        input([actor('a1', `${PACK}/probe-one`, 'working', 'renamed')], {
          t: 100,
        }),
      ),
    ).toStrictEqual([
      {
        type: 'frame',
        seq: 1,
        t: 100,
        dt: 100,
        actors: [{ actorId: 'a1', state: 'working' }],
        events: [
          { type: 'enter', actorId: 'b1' },
          { type: 'leave', actorId: 'b1' },
        ],
      },
    ]);
  });

  it('找不到: an own actor whose character is not in characters (or not in the manifest) is not sent at all, not even as another pack’s', () => {
    const state = newPackStageState();
    const messages = tick(
      state,
      input(
        [
          actor('a1', `${PACK}/probe-one`),
          actor('a2', `${PACK}/gone-one`),
          actor('a3', `${PACK}/probe-two`),
        ],
        {
          characters: {
            [`${PACK}/probe-one`]: CHARACTERS[
              `${PACK}/probe-one`
            ] as StageCharacter,
          },
        },
      ),
    );

    expect(messages[0]).toStrictEqual({
      type: 'init',
      actors: [
        {
          own: true,
          actorId: 'a1',
          characterId: 'probe-one',
          params: ONE_PARAMS,
          state: 'working',
          displayName: 'name a1',
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      actors: [{ actorId: 'a1', state: 'working' }],
    });
  });

  it('隱私: nothing sent has a session key, source, confidence, fixed parameter, motion or another pack’s characterId', () => {
    const state = newPackStageState();
    const all: StageMessage[] = [];
    const actors = [
      actor('b1', `${OTHER}/secret-character`),
      actor('a1', `${PACK}/probe-one`),
    ];
    all.push(...tick(state, input(actors)));
    answer(state);
    all.push(
      ...tick(
        state,
        input([...actors, actor('a2', `${PACK}/probe-two`)], {
          events: [{ type: 'enter', actorId: 'a2' }],
        }),
      ),
    );
    answer(state);
    all.push(
      ...tick(
        state,
        input([actor('a2', `${PACK}/probe-two`, 'done', 'other name')], {
          characters: {
            ...CHARACTERS,
            [`${PACK}/probe-two`]: {
              params: { 'blink-every': 7, mood: 'busy' },
              fixed: FIXED,
            },
          },
        }),
      ),
    );

    expect(all.map((message) => message.type)).toStrictEqual([
      'init',
      'frame',
      'spawn',
      'frame',
      'despawn',
      'params',
      'meta',
      'frame',
    ]);
    const keys = new Set(all.flatMap(keysIn));
    for (const key of FORBIDDEN) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(JSON.stringify(all)).not.toContain('secret-character');
    expect(JSON.stringify(all)).not.toContain(OTHER);
  });
});
