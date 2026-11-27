/**
 * pack-host's side of the stage messages and draws (Story 3.6): the check
 * of a `draw` (draw-rules.ts), and, around one pack-host with fake
 * iframes, a fake main, fake looks and a fake clock, what each tick posts
 * to a ready sandbox, which draws it keeps, and what it logs. And (Story
 * 3.9) the heartbeat and the draw timeout, counted in those ticks, and
 * the sandbox rebuilt on main's yes. The fake iframes answer each ping
 * with a pong at once, as the Worker bootstrap does, unless a test makes
 * a pack's Worker stuck; main says no to a rebuild unless a test says
 * yes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packLook, type PackLook } from '../../src/overlay/looks';
import {
  BITMAP_WINDOW_MS,
  checkDraw,
  closeBitmaps,
  countDrawCommands,
  countEmitters,
  createBitmapWindow,
  type DrawCheckLook,
} from '../../src/overlay/pack-host/draw-rules';
import {
  createPackHost,
  type PackHostApi,
  type SandboxFrameHandlers,
} from '../../src/overlay/pack-host/host';
import {
  bitmapCharactersOf,
  isPingMessage,
} from '../../src/sandbox/worker-bootstrap';
import {
  BITMAP_MAX_PER_SECOND,
  BITMAP_MAX_SIDE,
  DRAW_MAX_BYTES,
  DRAW_MAX_COMMANDS,
  DRAW_TIMEOUT_MS,
  DRAW_TIMEOUT_TICKS,
  HEARTBEAT_TICKS,
  HEARTBEAT_TIMEOUT_TICKS,
  PACK_DROP_LOG_INTERVAL_MS,
  PACK_MESSAGE_RATE_LIMIT,
  PARTICLE_EMITTERS_MAX,
  SANDBOX_IDLE_MS,
  TICK_HZ,
} from '../../src/shared/constants';
import {
  manifestSchema,
  type PackManifest,
  stageMessageSchema,
} from '../../src/shared/pack-api';
import type { StagePack } from '../../src/shared/packs';
import type { StageActor } from '../../src/shared/pool';
import {
  type PackLogEntry,
  packLogEntrySchema,
  type PackRuntimeFailure,
  sandboxBitmapCharactersMessage,
  sandboxPingMessage,
} from '../../src/shared/sandbox';
import type { StageCharacters, StageView } from '../../src/shared/stage-view';
import { contractManifest } from '../helpers/awpet';
import { FakeImageBitmap, stubImageBitmap } from '../helpers/fake-bitmaps';
import { fakeClock } from '../helpers/fake-clock';

const MANIFEST: PackManifest = manifestSchema.parse(contractManifest());
const SHEET = {
  image: 'img/probe-two-sheet.png',
  data: {
    frames: {
      'eyes-open': { frame: { x: 0, y: 0, w: 2, h: 2 } },
      'eyes-shut': { frame: { x: 2, y: 0, w: 2, h: 2 } },
    },
    meta: {
      image: 'probe-two-sheet.png',
      size: { w: 4, h: 2 },
      scale: 1 as const,
    },
  },
};

/** The contract pack's look under `packId` (the same manifest). */
function lookOf(packId: string, version = '1.0.0'): PackLook {
  return packLook(
    packId,
    version,
    { ...MANIFEST, id: packId, version },
    {
      'probe-two-sheet': SHEET,
    },
  );
}

const LOOK: DrawCheckLook = lookOf('alpha-pack');

/** The contract pack's look, its probe-one with advancedBitmap. */
function bitmapLookOf(packId: string, version = '1.0.0'): PackLook {
  return packLook(
    packId,
    version,
    {
      ...MANIFEST,
      id: packId,
      version,
      characters: MANIFEST.characters.map((character) =>
        character.id === 'probe-one'
          ? { ...character, advancedBitmap: true }
          : character,
      ),
    },
    { 'probe-two-sheet': SHEET },
  );
}

const SPRITE = { type: 'sprite', asset: 'probe-one-plain', x: -30, y: -110 };
const FRAMED = {
  type: 'sprite',
  asset: 'probe-two-sheet',
  frame: 'eyes-open',
  x: -25,
  y: -96,
};
const PARTICLES = {
  type: 'particles',
  emitterId: 'glow',
  preset: 'sparkle',
  x: 0,
  y: -120,
};
const BITMAP = {
  type: 'bitmap',
  image: {},
  x: 0,
  y: 0,
  width: 10,
  height: 10,
};

const FRAME_ACTORS = new Set(['a1', 'a2']);

function draw(actors: Record<string, unknown>, seq = 0): unknown {
  return { type: 'draw', seq, actors };
}

describe('I/O matrix', () => {
  it('出現: a draw for the frame’s actors whose sprites name manifest assets passes, as each actor’s sprites', () => {
    const check = checkDraw(
      draw({ a1: [SPRITE], a2: [FRAMED, { ...FRAMED, frame: 'eyes-shut' }] }),
      FRAME_ACTORS,
      LOOK,
    );
    expect(check).toStrictEqual({
      ok: true,
      actors: new Map([
        ['a1', [SPRITE]],
        ['a2', [FRAMED, { ...FRAMED, frame: 'eyes-shut' }]],
      ]),
    });
  });

  it('spritesheet: a sprite of the spritesheet with a frame name it has passes; one that names no frame, an unknown one, or a frame on a single image does not', () => {
    expect(checkDraw(draw({ a1: [FRAMED] }), FRAME_ACTORS, LOOK).ok).toBe(true);
    for (const sprite of [
      { ...FRAMED, frame: 'eyes-closed' },
      { type: 'sprite', asset: 'probe-two-sheet', x: 0, y: 0 },
      { ...SPRITE, frame: 'eyes-open' },
    ]) {
      expect(
        checkDraw(draw({ a1: [sprite] }), FRAME_ACTORS, LOOK),
      ).toStrictEqual({ ok: false, reason: 'unknown-frame' });
    }
  });

  it(`超過上限: over ${DRAW_MAX_BYTES} bytes or ${DRAW_MAX_COMMANDS} commands is dropped before it is parsed`, () => {
    const many = Array.from({ length: DRAW_MAX_COMMANDS + 1 }, () => SPRITE);
    expect(
      checkDraw(
        draw({ a1: many.slice(0, 200), a2: many.slice(200) }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-commands' });
    expect(
      checkDraw(
        draw({ a1: [{ ...SPRITE, asset: 'x'.repeat(DRAW_MAX_BYTES) }] }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'too-large' });
    // Not parsed yet: an over-long draw of nonsense is too-many, not invalid.
    expect(
      checkDraw(
        { type: 'draw', seq: 'x', actors: { a1: many }, extra: 1 },
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-commands' });
    expect(
      checkDraw(
        draw({ a1: many.slice(0, DRAW_MAX_COMMANDS) }),
        FRAME_ACTORS,
        LOOK,
      ).ok,
    ).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ['not plain data', draw({ a1: [new Map()] }), 'invalid'],
    ['a list for actors', { type: 'draw', seq: 0, actors: [] }, 'invalid'],
    ['an extra field', { ...(draw({}) as object), more: 1 }, 'invalid'],
    [
      'a sprite without x',
      draw({ a1: [{ type: 'sprite', asset: 'probe-one-plain', y: 0 }] }),
      'invalid',
    ],
    [
      'an undefined field',
      draw({ a1: [{ ...SPRITE, rotation: undefined }] }),
      'invalid',
    ],
    ['an actor not of its frame', draw({ a1: [], b1: [] }), 'not-own-actor'],
    [
      'an asset not in the manifest',
      draw({ a1: [{ ...SPRITE, asset: 'nothing-here' }] }),
      'unknown-asset',
    ],
    [
      'a frame on a single image',
      draw({ a1: [{ ...SPRITE, frame: 'x' }] }),
      'unknown-frame',
    ],
  ])('不合規: a draw with %s is dropped whole (%s)', (_label, data, reason) => {
    expect(checkDraw(data, FRAME_ACTORS, LOOK)).toStrictEqual({
      ok: false,
      reason,
    });
  });

  it('漏回: a draw leaving out one of the frame’s actors passes, without it', () => {
    const check = checkDraw(draw({ a1: [SPRITE] }), FRAME_ACTORS, LOOK);
    expect(check.ok && [...check.actors.keys()]).toStrictEqual(['a1']);
  });
});

/** `count` particles commands, each its own emitter id. */
function emitters(count: number, prefix = 'e'): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...PARTICLES,
    emitterId: `${prefix}${index}`,
  }));
}

describe('I/O matrix', () => {
  it('清單外 preset: a draw with a particles preset outside the list is dropped whole (invalid); each preset on it passes', () => {
    expect(
      checkDraw(
        draw({ a1: [SPRITE, { ...PARTICLES, preset: 'fireworks' }] }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'invalid' });
    for (const preset of ['sparkle', 'smoke', 'confetti', 'bubbles']) {
      expect(
        checkDraw(draw({ a1: [{ ...PARTICLES, preset }] }), FRAME_ACTORS, LOOK)
          .ok,
      ).toBe(true);
    }
  });

  it(`發射器上限: more than ${PARTICLE_EMITTERS_MAX} particles commands over all actors drop the draw whole (too-many-emitters); exactly that many pass`, () => {
    const half = PARTICLE_EMITTERS_MAX / 2;
    expect(
      checkDraw(
        draw({ a1: emitters(half), a2: emitters(half + 1) }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-emitters' });
    const most = checkDraw(
      draw({ a1: [SPRITE, ...emitters(half)], a2: emitters(half) }),
      FRAME_ACTORS,
      LOOK,
    );
    expect(most.ok).toBe(true);
    expect(most.ok && most.actors.get('a1')?.length).toBe(half + 1);
  });

  it('發射器上限: the emitters are counted after the schema and before the actors and assets', () => {
    const over = emitters(PARTICLE_EMITTERS_MAX + 1);
    // Not valid: invalid comes first.
    expect(
      checkDraw(
        draw({ a1: [...over, { type: 'sprite' }] }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'invalid' });
    // Valid, but for another actor and with an unknown asset: the emitters
    // are counted first.
    expect(
      checkDraw(
        draw({ b1: [...over, { ...SPRITE, asset: 'nothing-here' }] }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-emitters' });
  });
});

describe('countEmitters', () => {
  it('adds the particles commands of every actor up, stops past the limit, and counts anything else as 0', () => {
    expect(
      countEmitters(
        draw({ a1: [PARTICLES, SPRITE, PARTICLES], a2: [BITMAP, PARTICLES] }),
        10,
      ),
    ).toBe(3);
    expect(countEmitters(draw({ a1: emitters(5) }), 2)).toBe(3);
    expect(countEmitters(draw({ a1: [null, 'particles', 1] }), 2)).toBe(0);
    expect(countEmitters(draw({ a1: 'x' }), 2)).toBe(0);
    expect(countEmitters({ actors: [] }, 2)).toBe(0);
    expect(countEmitters(null, 2)).toBe(0);
  });
});

describe('countDrawCommands', () => {
  it('adds the lists of actors up, stops past the limit, and counts anything else as 0', () => {
    expect(countDrawCommands(draw({ a1: [1, 2], a2: [3] }), 10)).toBe(3);
    expect(countDrawCommands(draw({ a1: [1, 2], a2: [3] }), 2)).toBe(3);
    expect(countDrawCommands(draw({ a1: 'x' }), 2)).toBe(0);
    expect(countDrawCommands({ actors: [] }, 2)).toBe(0);
    expect(countDrawCommands(null, 2)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pack-host around it.

const ALPHA = 'alpha-pack';
const BRAVO = 'bravo-pack';

function stagePack(id: string, version = '1.0.0'): StagePack {
  return {
    id,
    name: id,
    version,
    apiVersion: '1.0',
    characters: [
      { id: 'probe-one', name: '甲', height: 110 },
      { id: 'probe-two', name: '乙', height: 96 },
    ],
    compatibility: { compatible: true },
  };
}

function actor(
  actorId: string,
  packId: string,
  characterId = 'probe-one',
  state: StageActor['state'] = 'working',
): StageActor {
  return {
    actorId,
    sessionKey: `claude-code:${actorId}`,
    characterKey: `${packId}/${characterId}`,
    state,
    confidence: 'inferred',
    displayName: `session ${actorId}`,
  };
}

const FIXED = {
  scale: 1,
  inPool: true,
  badges: true,
  wander: {
    enabled: true,
    activity: 'medium' as const,
    speed: 'medium' as const,
    areas: [6, 7, 8],
  },
};

function characters(...packIds: string[]): StageCharacters {
  const all: StageCharacters = {};
  for (const packId of packIds.sort()) {
    all[`${packId}/probe-one`] = {
      params: { glow: true, bob: 2, skin: 'probe-one-plain' },
      fixed: FIXED,
    };
    all[`${packId}/probe-two`] = {
      params: { 'blink-every': 3, mood: 'calm' },
      fixed: FIXED,
    };
  }
  return all;
}

function view(
  actors: readonly StageActor[],
): Pick<StageView, 'actors' | 'packs' | 'characters'> {
  return {
    actors: [...actors],
    packs: { installed: [stagePack(ALPHA), stagePack(BRAVO)] },
    characters: characters(ALPHA, BRAVO),
  };
}

const READY = {
  type: 'sandbox.ready',
  removals: [{ name: 'fetch', status: 'removed' }],
  consoleLines: 0,
} as const;

interface FakeFrame {
  readonly handlers: SandboxFrameHandlers;
  readonly posted: unknown[];
  removed: boolean;
}

function setup(
  options: {
    looks?: boolean;
    /** ALPHA's probe-one has advancedBitmap (bitmapLookOf). */
    bitmap?: boolean;
    /** main's answer to `packs:runtime-failed` (Story 3.9); no by default. */
    restart?: boolean;
  } = {},
) {
  const clock = fakeClock();
  const logs: PackLogEntry[] = [];
  const frames = new Map<string, FakeFrame>();
  /** What `packs:runtime-failed` was called with (Story 3.9). */
  const failures: PackRuntimeFailure[] = [];
  /** The packs whose Worker is stuck: it answers no ping. */
  const stuck = new Set<string>();
  /** The packs whose entry was asked for, in order: frames come in it. */
  const asked: string[] = [];
  const api: PackHostApi = {
    getEntry: vi.fn(async (packId: string) => {
      asked.push(packId);
      return {
        ok: true as const,
        data: {
          ok: true as const,
          packId,
          version: '1.0.0',
          source: '(function () { return {}; });',
        },
      };
    }),
    log: vi.fn(async (entry: PackLogEntry) => {
      expect(packLogEntrySchema.safeParse(entry).success).toBe(true);
      logs.push(entry);
      return { ok: true as const, data: null };
    }),
    runtimeFailed: vi.fn(async (failure: PackRuntimeFailure) => {
      failures.push(failure);
      return {
        ok: true as const,
        data: { restart: options.restart === true },
      };
    }),
  };
  const looks = new Map<string, PackLook>(
    options.looks === false
      ? []
      : [
          [
            ALPHA,
            options.bitmap === true ? bitmapLookOf(ALPHA) : lookOf(ALPHA),
          ],
          [BRAVO, lookOf(BRAVO)],
        ],
  );
  const host = createPackHost({
    api,
    frames: {
      create(handlers) {
        const frame: FakeFrame = { handlers, posted: [], removed: false };
        const packId = asked.shift() ?? '';
        frames.set(packId, frame);
        return {
          hand() {},
          post(message) {
            if (!stageMessageSchema.safeParse(message).success) {
              // pack-host's own message, exactly as the bootstrap takes it:
              // `type` and a list of strings `characterIds`, nothing else;
              // or exactly the ping (Story 3.9).
              expect(
                bitmapCharactersOf(message) !== undefined ||
                  isPingMessage(message),
              ).toBe(true);
            }
            frame.posted.push(structuredClone(message));
            if (isPingMessage(message) && !stuck.has(packId)) {
              // The bootstrap answers at once, outside the pack's code.
              handlers.onMessage({ type: 'sandbox.pong' });
            }
          },
          remove() {
            frame.removed = true;
          },
        };
      },
    },
    clock: {
      now: clock.monotonic,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
    looks: { get: (packId) => looks.get(packId) },
    logError: () => {},
  });
  return { host, clock, logs, frames, looks, failures, stuck };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** Shows `actors`, brings up each new sandbox one at a time, ready. */
async function showReady(
  t: ReturnType<typeof setup>,
  actors: readonly StageActor[],
): Promise<void> {
  t.host.onView(view(actors));
  await settle();
  for (const frame of t.frames.values()) {
    frame.handlers.onLoad();
    frame.handlers.onMessage(READY);
  }
}

function frameOf(t: ReturnType<typeof setup>, packId: string): FakeFrame {
  const frame = t.frames.get(packId);
  if (frame === undefined) {
    throw new Error(`no frame for ${packId}`);
  }
  return frame;
}

function types(frame: FakeFrame): string[] {
  return frame.posted.map((message) => (message as { type: string }).type);
}

/** The ms between ticks. */
const TICK = 1000 / TICK_HZ;

/** A `frame` as pack-host posted it. */
interface PostedFrame {
  readonly seq: number;
  readonly actors: readonly { readonly actorId: string }[];
}

/**
 * Ticks `count` times, from tick number `from` (its stage time `from` ×
 * TICK), the clock a tick on after each; after each tick, `answer` gets
 * every `frame` that tick sent, with the pack it went to.
 */
function runTicks(
  t: ReturnType<typeof setup>,
  from: number,
  count: number,
  answer: (packId: string, frame: PostedFrame) => void = () => {},
): void {
  for (let n = from; n < from + count; n += 1) {
    const before = new Map(
      [...t.frames].map(([packId, frame]) => [packId, frame.posted.length]),
    );
    t.host.tick({ t: n * TICK, events: [] });
    for (const [packId, frame] of t.frames) {
      for (const message of frame.posted.slice(before.get(packId) ?? 0)) {
        if ((message as { type: string }).type === 'frame') {
          answer(packId, message as PostedFrame);
        }
      }
    }
    t.clock.advance(TICK);
  }
}

/** Answers `frame` with a valid draw: an empty list for each of its actors. */
function answerEmpty(t: ReturnType<typeof setup>) {
  return (packId: string, frame: PostedFrame): void => {
    frameOf(t, packId).handlers.onMessage(
      draw(
        Object.fromEntries(frame.actors.map(({ actorId }) => [actorId, []])),
        frame.seq,
      ),
    );
  };
}

/** The `sandbox-failed` lines. */
function failedLines(t: ReturnType<typeof setup>): PackLogEntry[] {
  return t.logs.filter((entry) => entry.kind === 'sandbox-failed');
}

describe('I/O matrix', () => {
  it('出現: a ready sandbox gets init then a frame at the first tick; the draw it answers with is its latest valid draw', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);

    t.host.tick({ t: 0, events: [{ type: 'enter', actorId: 'a1' }] });

    const alpha = frameOf(t, ALPHA);
    expect(alpha.posted).toStrictEqual([
      {
        type: 'init',
        actors: [
          {
            own: true,
            actorId: 'a1',
            characterId: 'probe-one',
            params: { glow: true, bob: 2, skin: 'probe-one-plain' },
            state: 'working',
            displayName: 'session a1',
          },
        ],
      },
      {
        type: 'frame',
        seq: 0,
        t: 0,
        dt: 0,
        actors: [{ actorId: 'a1', state: 'working' }],
        events: [],
      },
    ]);
    expect(t.host.drawOf(ALPHA)).toBeUndefined();

    alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));

    expect(t.host.drawOf(ALPHA)).toStrictEqual({
      version: '1.0.0',
      actors: new Map([['a1', [SPRITE]]]),
    });
    t.host.tick({ t: 33, events: [] });
    expect(types(alpha)).toStrictEqual(['init', 'frame', 'frame']);
    expect(
      t.logs.filter((entry) => entry.kind === 'messages-dropped'),
    ).toStrictEqual([]);
  });

  it('出現: no message before the sandbox is ready, nor before its look has come', async () => {
    const t = setup({ looks: false });
    t.host.onView(view([actor('a1', ALPHA)]));
    await settle();
    t.host.tick({ t: 0, events: [] });
    const alpha = frameOf(t, ALPHA);
    expect(alpha.posted).toStrictEqual([]);

    alpha.handlers.onLoad();
    alpha.handlers.onMessage(READY);
    t.host.tick({ t: 33, events: [] });
    expect(alpha.posted).toStrictEqual([]);

    t.looks.set(ALPHA, lookOf(ALPHA));
    t.host.tick({ t: 66, events: [] });
    expect(types(alpha)).toStrictEqual(['init', 'frame']);
    expect(alpha.posted[1]).toMatchObject({ seq: 0, t: 66, dt: 0 });
  });

  it('在途: while its frame is unanswered a pack gets no frame (spawns still go), and its latest draw stays', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    t.host.tick({ t: 0, events: [] });
    const alpha = frameOf(t, ALPHA);
    alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));
    t.host.tick({ t: 33, events: [] });
    const before = t.host.drawOf(ALPHA);

    t.host.onView(view([actor('a1', ALPHA), actor('a2', ALPHA, 'probe-two')]));
    t.host.tick({ t: 66, events: [{ type: 'enter', actorId: 'a2' }] });
    t.host.tick({ t: 100, events: [] });

    expect(types(alpha)).toStrictEqual(['init', 'frame', 'frame', 'spawn']);
    expect(t.host.drawOf(ALPHA)).toBe(before);

    alpha.handlers.onMessage(draw({ a1: [{ ...SPRITE, x: 0 }] }, 1));
    t.host.tick({ t: 133, events: [] });
    expect(types(alpha).at(-1)).toBe('frame');
    expect(alpha.posted.at(-1)).toMatchObject({
      seq: 2,
      dt: 100,
      actors: [
        { actorId: 'a1', state: 'working' },
        { actorId: 'a2', state: 'working' },
      ],
      events: [{ type: 'enter', actorId: 'a2' }],
    });
  });

  it(`一包變慢: a pack that never answers stops getting frames; the other goes on getting them and its draws are taken. Stuck (it answers no ping either), it fails as heartbeat-timeout at its ${HEARTBEAT_TIMEOUT_TICKS}th tick, its actors in the placeholder, and the other goes on as before`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);
    t.stuck.add(ALPHA);
    const alpha = frameOf(t, ALPHA);
    const bravo = frameOf(t, BRAVO);
    const answerBravo = (packId: string, frame: PostedFrame): void => {
      if (packId === BRAVO) {
        bravo.handlers.onMessage(
          draw({ b1: [{ ...SPRITE, x: frame.seq }] }, frame.seq),
        );
      }
    };

    runTicks(t, 0, 5, answerBravo);

    expect(types(alpha)).toStrictEqual(['init', 'frame']);
    expect(types(bravo)).toStrictEqual([
      'init',
      'frame',
      'frame',
      'frame',
      'frame',
      'frame',
    ]);
    expect(t.host.drawOf(BRAVO)?.actors.get('b1')).toStrictEqual([
      { ...SPRITE, x: 4 },
    ]);
    expect(t.host.drawOf(ALPHA)).toBeUndefined();

    // Story 3.9: its pings (one every HEARTBEAT_TICKS) go unanswered.
    runTicks(t, 5, HEARTBEAT_TIMEOUT_TICKS - 6, answerBravo);
    expect(t.host.phases().get(ALPHA)).toBe('ready');
    expect(types(alpha)).toStrictEqual([
      'init',
      'frame',
      ...Array.from(
        { length: Math.floor((HEARTBEAT_TIMEOUT_TICKS - 1) / HEARTBEAT_TICKS) },
        () => 'sandbox.ping',
      ),
    ]);
    expect(failedLines(t)).toStrictEqual([]);

    runTicks(t, HEARTBEAT_TIMEOUT_TICKS - 1, 1, answerBravo);
    expect(failedLines(t)).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'heartbeat-timeout' },
    ]);
    expect(alpha.removed).toBe(true);
    expect(t.failures).toStrictEqual([
      { packId: ALPHA, version: '1.0.0', reason: 'heartbeat-timeout' },
    ]);
    expect(t.host.troubled(ALPHA)).toBe(true);
    expect(t.host.troubled(BRAVO)).toBe(false);

    runTicks(t, HEARTBEAT_TIMEOUT_TICKS, 10, answerBravo);
    expect(types(bravo).filter((type) => type === 'frame')).toHaveLength(
      HEARTBEAT_TIMEOUT_TICKS + 10,
    );
    expect(t.host.drawOf(BRAVO)?.actors.get('b1')).toStrictEqual([
      { ...SPRITE, x: HEARTBEAT_TIMEOUT_TICKS + 9 },
    ]);
    expect(t.host.phases().get(BRAVO)).toBe('ready');
    expect(failedLines(t)).toHaveLength(1);
  });

  it('加入與移出: a draw naming an actor that left after its frame is still taken (checked against that frame’s actors)', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('a2', ALPHA)]);
    t.host.tick({ t: 0, events: [] });
    const alpha = frameOf(t, ALPHA);

    t.host.onView(view([actor('a2', ALPHA)]));
    t.host.tick({ t: 33, events: [{ type: 'leave', actorId: 'a1' }] });
    expect(types(alpha)).toStrictEqual(['init', 'frame', 'despawn']);

    alpha.handlers.onMessage(draw({ a1: [SPRITE], a2: [SPRITE] }, 0));
    expect([...(t.host.drawOf(ALPHA)?.actors.keys() ?? [])]).toStrictEqual([
      'a1',
      'a2',
    ]);
  });

  it.each<[string, unknown, string]>([
    [
      'over the command limit',
      draw({ a1: Array.from({ length: DRAW_MAX_COMMANDS + 1 }, () => SPRITE) }),
      'too-many-commands',
    ],
    [
      'over the byte limit',
      draw({ a1: [{ ...SPRITE, asset: 'x'.repeat(DRAW_MAX_BYTES) }] }),
      'too-large',
    ],
    ['not fitting the schema', draw({ a1: [{ type: 'sprite' }] }), 'invalid'],
    [
      'for an actor that is not its own',
      draw({ b1: [SPRITE] }),
      'not-own-actor',
    ],
    [
      'with an asset not in its manifest',
      draw({ a1: [{ ...SPRITE, asset: 'elsewhere' }] }),
      'unknown-asset',
    ],
    [
      'with a frame on a single image',
      draw({ a1: [{ ...SPRITE, frame: 'eyes-open' }] }),
      'unknown-frame',
    ],
    [
      'with a preset outside the list (清單外 preset)',
      draw({ a1: [SPRITE, { ...PARTICLES, preset: 'fireworks' }] }),
      'invalid',
    ],
    [
      'with too many emitters (發射器上限)',
      draw({ a1: emitters(PARTICLE_EMITTERS_MAX + 1) }),
      'too-many-emitters',
    ],
  ])(
    '不合規: a draw %s is dropped whole, its frame counts as answered, and one line names the pack',
    async (_label, data, reason) => {
      const t = setup();
      await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);
      t.host.tick({ t: 0, events: [] });
      const alpha = frameOf(t, ALPHA);
      alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));
      t.host.tick({ t: 33, events: [] });
      t.logs.length = 0;

      alpha.handlers.onMessage({ ...(data as object), seq: 1 });

      expect(t.logs).toStrictEqual([
        { kind: 'messages-dropped', packId: ALPHA, reason, count: 1 },
      ]);
      expect(t.host.drawOf(ALPHA)?.actors.get('a1')).toStrictEqual([SPRITE]);
      t.host.tick({ t: 66, events: [] });
      expect(types(alpha).at(-1)).toBe('frame');
    },
  );

  it('不合規: drops are logged at most once per pack and reason in the interval, the next line counting them', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    t.logs.length = 0;
    for (let seq = 0; seq < 4; seq += 1) {
      t.host.tick({ t: seq * 33, events: [] });
      alpha.handlers.onMessage(
        draw({ a1: [{ ...SPRITE, asset: 'elsewhere' }] }, seq),
      );
    }
    t.clock.advance(PACK_DROP_LOG_INTERVAL_MS);
    t.host.tick({ t: 1000, events: [] });
    alpha.handlers.onMessage(
      draw({ a1: [{ ...SPRITE, asset: 'elsewhere' }] }, 4),
    );

    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'unknown-asset',
        count: 1,
      },
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'unknown-asset',
        count: 4,
      },
    ]);
  });

  it(`在途: a draw refused for the pack's message rate (${PACK_MESSAGE_RATE_LIMIT} a window) still answers its frame: the next tick sends one`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    t.host.tick({ t: 0, events: [] });
    t.logs.length = 0;
    for (let i = 0; i < PACK_MESSAGE_RATE_LIMIT; i += 1) {
      alpha.handlers.onMessage({ type: 'stage.hold', actorId: 'a1', on: true });
    }

    alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));
    t.host.tick({ t: 33, events: [] });

    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'rate-limited',
        count: 1,
      },
    ]);
    expect(t.host.drawOf(ALPHA)).toBeUndefined();
    expect(alpha.posted.at(-1)).toMatchObject({ type: 'frame', seq: 1 });
  });

  it('在途: a draw for a seq not in flight (late, made up, or with no frame sent) is stale and changes nothing', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    t.logs.length = 0;

    alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));
    t.host.tick({ t: 0, events: [] });
    alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 7));

    expect(t.host.drawOf(ALPHA)).toBeUndefined();
    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'stale-draw',
        count: 1,
      },
    ]);
    // Seq 0 is still in flight: no frame at the next tick.
    t.host.tick({ t: 33, events: [] });
    expect(types(alpha)).toStrictEqual(['init', 'frame']);
  });

  it.each(['no-frame-handler', 'frame-threw', 'draw-not-cloneable'] as const)(
    '在途: the bootstrap’s no-draw (%s) answers the frame: the next tick sends one, the drop is logged, the latest draw stays',
    async (reason) => {
      const t = setup();
      await showReady(t, [actor('a1', ALPHA)]);
      const alpha = frameOf(t, ALPHA);
      t.host.tick({ t: 0, events: [] });
      alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));
      t.host.tick({ t: 33, events: [] });
      t.logs.length = 0;

      alpha.handlers.onMessage({ type: 'sandbox.no-draw', seq: 1, reason });
      t.host.tick({ t: 66, events: [] });

      expect(types(alpha)).toStrictEqual(['init', 'frame', 'frame', 'frame']);
      expect(t.logs).toStrictEqual([
        { kind: 'messages-dropped', packId: ALPHA, reason, count: 1 },
      ]);
      expect(t.host.drawOf(ALPHA)?.actors.get('a1')).toStrictEqual([SPRITE]);
    },
  );

  it('漏回: a valid draw that leaves an actor out replaces the latest one; that actor has no commands in it', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('a2', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    t.host.tick({ t: 0, events: [] });
    alpha.handlers.onMessage(draw({ a1: [SPRITE], a2: [SPRITE] }, 0));
    t.host.tick({ t: 33, events: [] });
    alpha.handlers.onMessage(draw({ a2: [] }, 1));

    expect(t.host.drawOf(ALPHA)?.actors).toStrictEqual(new Map([['a2', []]]));
  });

  it('a failed or destroyed sandbox takes its draw and its unanswered frame with it', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    t.host.tick({ t: 0, events: [] });
    alpha.handlers.onMessage(draw({ a1: [SPRITE] }, 0));
    expect(t.host.drawOf(ALPHA)).toBeDefined();

    alpha.handlers.onMessage({ type: 'sandbox.fault', fault: 'error' });
    expect(t.host.drawOf(ALPHA)).toBeUndefined();
    t.host.tick({ t: 33, events: [] });
    expect(types(alpha)).toStrictEqual(['init', 'frame']);
  });

  it('a no-draw before the sandbox is ready fails it as a bad report', async () => {
    const t = setup();
    t.host.onView(view([actor('a1', ALPHA)]));
    await settle();
    const alpha = frameOf(t, ALPHA);
    alpha.handlers.onLoad();
    t.logs.length = 0;

    alpha.handlers.onMessage({
      type: 'sandbox.no-draw',
      seq: 0,
      reason: 'frame-threw',
    });

    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'bad-report' },
    ]);
    expect(alpha.removed).toBe(true);
  });

  it('a version change destroys the sandbox: its draw goes, and the new one starts with init', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    t.host.tick({ t: 0, events: [] });
    frameOf(t, ALPHA).handlers.onMessage(draw({ a1: [SPRITE] }, 0));

    t.host.onView({
      ...view([actor('a1', ALPHA)]),
      packs: { installed: [stagePack(ALPHA, '1.1.0'), stagePack(BRAVO)] },
    });
    expect(t.host.drawOf(ALPHA)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Story 3.9: the heartbeat, the draw timeout and the rebuild.

describe('I/O matrix', () => {
  it(`健康: a pack answering every frame (with empty draws) and every ping goes on with no failure, ten times ${HEARTBEAT_TIMEOUT_TICKS} ticks (past ${DRAW_TIMEOUT_MS} ms); it gets a ping every ${HEARTBEAT_TICKS} ticks, after that tick's stage messages`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('a2', ALPHA, 'probe-two')]);
    const alpha = frameOf(t, ALPHA);

    runTicks(t, 0, 10 * HEARTBEAT_TIMEOUT_TICKS, answerEmpty(t));

    expect(failedLines(t)).toStrictEqual([]);
    expect(t.failures).toStrictEqual([]);
    expect(t.host.phases().get(ALPHA)).toBe('ready');
    expect(t.host.troubled(ALPHA)).toBe(false);
    const posted = types(alpha);
    expect(posted.filter((type) => type === 'sandbox.ping')).toHaveLength(
      (10 * HEARTBEAT_TIMEOUT_TICKS) / HEARTBEAT_TICKS,
    );
    expect(posted.filter((type) => type === 'frame')).toHaveLength(
      10 * HEARTBEAT_TIMEOUT_TICKS,
    );
    // The init and the first HEARTBEAT_TICKS ticks' frames, then the ping.
    const first = posted.indexOf('sandbox.ping');
    expect(posted.slice(0, first)).toStrictEqual([
      'init',
      ...Array.from({ length: HEARTBEAT_TICKS }, () => 'frame'),
    ]);
    expect(alpha.posted[first]).toStrictEqual(sandboxPingMessage());
    expect(
      t.logs.filter((entry) => entry.kind === 'messages-dropped'),
    ).toStrictEqual([]);
  });

  it('pong: a pong before ready fails the sandbox as a bad report; once ready, each pong starts the heartbeat count again', async () => {
    const t = setup();
    t.host.onView(view([actor('a1', ALPHA)]));
    await settle();
    const alpha = frameOf(t, ALPHA);
    alpha.handlers.onLoad();
    alpha.handlers.onMessage({ type: 'sandbox.pong' });
    expect(failedLines(t)).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'bad-report' },
    ]);

    const u = setup();
    await showReady(u, [actor('a1', ALPHA)]);
    u.stuck.add(ALPHA);
    const answer = answerEmpty(u);
    // A pong of its own now and then, just in time: never stuck long enough.
    for (let n = 0; n < 5; n += 1) {
      runTicks(
        u,
        n * (HEARTBEAT_TIMEOUT_TICKS - 1),
        HEARTBEAT_TIMEOUT_TICKS - 1,
        answer,
      );
      frameOf(u, ALPHA).handlers.onMessage({ type: 'sandbox.pong' });
    }
    expect(failedLines(u)).toStrictEqual([]);
    runTicks(
      u,
      5 * (HEARTBEAT_TIMEOUT_TICKS - 1),
      HEARTBEAT_TIMEOUT_TICKS,
      answer,
    );
    expect(failedLines(u)).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'heartbeat-timeout' },
    ]);
  });

  it.each<[string, (t: ReturnType<typeof setup>, frame: PostedFrame) => void]>([
    [
      'over a limit (each draw dropped)',
      (t, frame) => {
        frameOf(t, ALPHA).handlers.onMessage(
          draw(
            {
              a1: Array.from({ length: DRAW_MAX_COMMANDS + 1 }, () => SPRITE),
            },
            frame.seq,
          ),
        );
      },
    ],
    [
      'answered with sandbox.no-draw',
      (t, frame) => {
        frameOf(t, ALPHA).handlers.onMessage({
          type: 'sandbox.no-draw',
          seq: frame.seq,
          reason: 'draw-too-large',
        });
      },
    ],
    ['never answered (its pings are)', () => {}],
  ])(
    `一直無效: a pack whose every frame is %s fails as draw-timeout once it has gone ${DRAW_TIMEOUT_MS} ms of ticks with its actor and no valid draw; main saying no leaves it failed, its actors in the placeholder`,
    async (_label, answer) => {
      const t = setup();
      await showReady(t, [actor('a1', ALPHA)]);
      const alpha = frameOf(t, ALPHA);

      // The first tick sends the init: from the next the pack has its actor.
      runTicks(t, 0, DRAW_TIMEOUT_TICKS, (_packId, frame) => {
        answer(t, frame);
      });
      expect(t.host.phases().get(ALPHA)).toBe('ready');
      expect(failedLines(t)).toStrictEqual([]);

      runTicks(t, DRAW_TIMEOUT_TICKS, 1, (_packId, frame) => {
        answer(t, frame);
      });
      expect(failedLines(t)).toStrictEqual([
        { kind: 'sandbox-failed', packId: ALPHA, reason: 'draw-timeout' },
      ]);
      expect(alpha.removed).toBe(true);
      expect(t.failures).toStrictEqual([
        { packId: ALPHA, version: '1.0.0', reason: 'draw-timeout' },
      ]);

      await settle();
      runTicks(t, DRAW_TIMEOUT_TICKS + 1, 10);
      expect(frameOf(t, ALPHA)).toBe(alpha);
      expect(t.host.phases().get(ALPHA)).toBe('failed');
      expect(t.host.troubled(ALPHA)).toBe(true);
      expect(t.host.drawOf(ALPHA)).toBeUndefined();
    },
  );

  it('偶爾超限: a pack whose draws are mostly over a limit, with a valid one just in time each time, only has those dropped and does not fail; nor does one whose stage.log calls go over the stage.log rate of their own', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    const over = Array.from({ length: DRAW_MAX_COMMANDS + 1 }, () => SPRITE);

    runTicks(t, 0, 3 * DRAW_TIMEOUT_TICKS, (_packId, frame) => {
      const valid =
        frame.seq % (DRAW_TIMEOUT_TICKS - 1) === DRAW_TIMEOUT_TICKS - 2;
      alpha.handlers.onMessage(
        draw({ a1: valid ? [SPRITE] : over }, frame.seq),
      );
      // Two stage.log calls a tick: past their own rate, dropped only.
      alpha.handlers.onMessage({ type: 'stage.log', text: 'x' });
      alpha.handlers.onMessage({ type: 'stage.log', text: 'y' });
    });

    expect(failedLines(t)).toStrictEqual([]);
    expect(t.host.phases().get(ALPHA)).toBe('ready');
    const dropped = new Set(
      t.logs.flatMap((entry) =>
        entry.kind === 'messages-dropped' ? [entry.reason] : [],
      ),
    );
    expect(dropped).toStrictEqual(
      new Set(['too-many-commands', 'log-rate-limited']),
    );
  });

  it('只計處理到的 tick: no tick counts while the pack’s look has not come (no ping either); none counts towards the draw timeout while the pack has no own actor', async () => {
    const t = setup({ looks: false });
    await showReady(t, [actor('a1', ALPHA)]);
    t.stuck.add(ALPHA);
    const alpha = frameOf(t, ALPHA);
    runTicks(t, 0, 2 * DRAW_TIMEOUT_TICKS);
    expect(alpha.posted).toStrictEqual([]);
    expect(failedLines(t)).toStrictEqual([]);

    t.looks.set(ALPHA, lookOf(ALPHA));
    runTicks(t, 0, HEARTBEAT_TIMEOUT_TICKS - 1);
    expect(failedLines(t)).toStrictEqual([]);
    runTicks(t, HEARTBEAT_TIMEOUT_TICKS - 1, 1);
    expect(failedLines(t)).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'heartbeat-timeout' },
    ]);

    // The draw timeout: alpha never draws, but answers its pings; bravo's
    // actor keeps the stage ticking.
    const u = setup();
    await showReady(u, [actor('a1', ALPHA), actor('b1', BRAVO)]);
    const answer = answerEmpty(u);
    const bravoOnly = (packId: string, frame: PostedFrame): void => {
      if (packId === BRAVO) {
        answer(packId, frame);
      }
    };
    // 1 tick with the init, then 199 with a1.
    runTicks(u, 0, 200, bravoOnly);
    u.host.onView(view([actor('b1', BRAVO)]));
    // 1 more with a1 (its despawn goes), then none with an own actor,
    // however many: well within SANDBOX_IDLE_MS of the clock.
    runTicks(u, 200, 2 * DRAW_TIMEOUT_TICKS, bravoOnly);
    expect(failedLines(u)).toStrictEqual([]);
    expect(u.host.phases().get(ALPHA)).toBe('ready');

    u.host.onView(view([actor('a2', ALPHA), actor('b1', BRAVO)]));
    // 1 tick with the spawn, then the count goes on from 200.
    runTicks(u, 800, DRAW_TIMEOUT_TICKS - 200, bravoOnly);
    expect(failedLines(u)).toStrictEqual([]);
    runTicks(u, 900, 1, bravoOnly);
    expect(failedLines(u)).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'draw-timeout' },
    ]);
  });

  it('重建: on main’s yes the pack gets a new sandbox; its first tick sends init with every actor on stage, its own by their actorId; its actors stay in the placeholder through a no-draw and a dropped draw, until its first valid draw', async () => {
    const t = setup({ restart: true });
    await showReady(t, [
      actor('a1', ALPHA),
      actor('a2', ALPHA, 'probe-two'),
      actor('b1', BRAVO),
    ]);
    t.stuck.add(ALPHA);
    const old = frameOf(t, ALPHA);
    const answer = answerEmpty(t);
    runTicks(t, 0, HEARTBEAT_TIMEOUT_TICKS, (packId, frame) => {
      if (packId === BRAVO) {
        answer(packId, frame);
      }
    });
    expect(old.removed).toBe(true);
    expect(t.host.troubled(ALPHA)).toBe(true);

    await settle();
    const fresh = frameOf(t, ALPHA);
    expect(fresh).not.toBe(old);
    t.stuck.delete(ALPHA);
    fresh.handlers.onLoad();
    fresh.handlers.onMessage(READY);
    expect(t.host.troubled(ALPHA)).toBe(true);
    t.host.tick({ t: 9000, events: [] });

    expect(types(fresh)).toStrictEqual(['init', 'frame']);
    expect(fresh.posted[0]).toStrictEqual({
      type: 'init',
      actors: [
        {
          own: true,
          actorId: 'a1',
          characterId: 'probe-one',
          params: { glow: true, bob: 2, skin: 'probe-one-plain' },
          state: 'working',
          displayName: 'session a1',
        },
        {
          own: true,
          actorId: 'a2',
          characterId: 'probe-two',
          params: { 'blink-every': 3, mood: 'calm' },
          state: 'working',
          displayName: 'session a2',
        },
        { own: false, actorId: 'b1', state: 'working' },
      ],
    });
    expect(fresh.posted[1]).toMatchObject({ type: 'frame', seq: 0 });

    fresh.handlers.onMessage({
      type: 'sandbox.no-draw',
      seq: 0,
      reason: 'frame-threw',
    });
    expect(t.host.troubled(ALPHA)).toBe(true);
    t.host.tick({ t: 9033, events: [] });
    fresh.handlers.onMessage(draw({ a1: [{ ...SPRITE, asset: 'nope' }] }, 1));
    expect(t.host.troubled(ALPHA)).toBe(true);
    expect(t.host.drawOf(ALPHA)).toBeUndefined();
    t.host.tick({ t: 9066, events: [] });
    fresh.handlers.onMessage(draw({ a1: [SPRITE], a2: [] }, 2));

    expect(t.host.troubled(ALPHA)).toBe(false);
    expect(t.host.drawOf(ALPHA)?.actors).toStrictEqual(
      new Map([
        ['a1', [SPRITE]],
        ['a2', []],
      ]),
    );
    expect(t.failures).toHaveLength(1);
  });

  it('同版本重新匯入: main’s no stops the failed sandbox, its actor (demo mode’s, say) in the placeholder through the failure mark; the same version imported again clears the mark and rebuilds it, in the placeholder until its first valid draw', async () => {
    const t = setup();
    const actors = [actor('a1', ALPHA)];
    await showReady(t, actors);
    t.stuck.add(ALPHA);
    const old = frameOf(t, ALPHA);
    runTicks(t, 0, HEARTBEAT_TIMEOUT_TICKS);
    await settle();
    expect(old.removed).toBe(true);
    expect(t.failures).toStrictEqual([
      { packId: ALPHA, version: '1.0.0', reason: 'heartbeat-timeout' },
    ]);

    // main marks the version failed; demo mode keeps its actor on stage.
    t.host.onView({
      ...view(actors),
      packs: {
        installed: [
          { ...stagePack(ALPHA), runtimeFailed: 'heartbeat-timeout' },
          stagePack(BRAVO),
        ],
      },
    });
    await settle();
    expect(frameOf(t, ALPHA)).toBe(old);
    expect(t.host.phases().get(ALPHA)).toBe('failed');
    expect(t.host.troubled(ALPHA)).toBe(true);

    // Imported again at 1.0.0: the mark is gone, the version the same.
    t.stuck.delete(ALPHA);
    t.host.onView(view(actors));
    await settle();
    const fresh = frameOf(t, ALPHA);
    expect(fresh).not.toBe(old);
    fresh.handlers.onLoad();
    fresh.handlers.onMessage(READY);
    expect(t.host.troubled(ALPHA)).toBe(true);
    t.host.tick({ t: 9000, events: [] });
    expect(types(fresh)).toStrictEqual(['init', 'frame']);
    expect(t.host.troubled(ALPHA)).toBe(true);
    fresh.handlers.onMessage(draw({ a1: [SPRITE] }, 0));

    expect(t.host.troubled(ALPHA)).toBe(false);
    expect(t.host.drawOf(ALPHA)?.actors).toStrictEqual(
      new Map([['a1', [SPRITE]]]),
    );
    expect(t.failures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bitmaps (Story 3.6's last part). FakeImageBitmap is the global
// ImageBitmap here; a1 plays probe-one, which has advancedBitmap in
// BITMAP_LOOK, and a2 probe-two, which has not.

const BITMAP_LOOK: DrawCheckLook = bitmapLookOf(ALPHA);

const CHARACTERS: Readonly<Record<string, string>> = {
  a1: 'probe-one',
  a2: 'probe-two',
};

function bitmapOf(image: object, more: Record<string, unknown> = {}) {
  return {
    type: 'bitmap',
    image,
    x: -32,
    y: -100,
    width: 64,
    height: 64,
    ...more,
  };
}

/** checkDraw with BITMAP_LOOK, the characters above and `allowance`. */
function checkBitmaps(
  data: unknown,
  allowance: (actorId: string) => number = () => BITMAP_MAX_PER_SECOND,
) {
  return checkDraw(data, FRAME_ACTORS, BITMAP_LOOK, {
    characterOf: (actorId) => CHARACTERS[actorId],
    bitmapAllowance: allowance,
  });
}

describe('I/O matrix', () => {
  beforeEach(() => {
    stubImageBitmap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bitmap 出現: a bitmap of an actor whose character has advancedBitmap passes, kept with the actor’s other commands in the pack’s order', () => {
    const image = new FakeImageBitmap(64, 64);
    const bitmap = bitmapOf(image);

    const check = checkBitmaps(
      draw({ a1: [SPRITE, bitmap, PARTICLES], a2: [SPRITE] }),
    );

    expect(check).toStrictEqual({
      ok: true,
      actors: new Map([
        ['a1', [SPRITE, bitmap, PARTICLES]],
        ['a2', [SPRITE]],
      ]),
    });
    expect(check.ok && check.actors.get('a1')?.[1]).toMatchObject({ image });
    expect(
      check.ok &&
        (check.actors.get('a1')?.[1] as { image: unknown } | undefined)?.image,
    ).toBe(image);
  });

  it(`位元組: an ImageBitmap counts as {} (2 bytes) in the ${DRAW_MAX_BYTES}-byte limit`, () => {
    const bitmap = bitmapOf(
      new FakeImageBitmap(BITMAP_MAX_SIDE, BITMAP_MAX_SIDE),
    );
    // A sprite's frame name has no length limit of its own (on a single
    // image it fails later, as unknown-frame).
    const at = (length: number) =>
      draw({ a1: [bitmap, { ...SPRITE, frame: 'x'.repeat(length) }] });
    const bytes = (data: unknown) =>
      JSON.stringify(data, (_key, value: unknown) =>
        value instanceof FakeImageBitmap ? {} : value,
      ).length;
    const pad = DRAW_MAX_BYTES - bytes(at(0));
    expect(bytes(at(pad))).toBe(DRAW_MAX_BYTES);

    // The bytes have passed: its frame fails later.
    expect(checkBitmaps(at(pad))).toStrictEqual({
      ok: false,
      reason: 'unknown-frame',
    });
    expect(checkBitmaps(at(pad + 1))).toStrictEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it.each<
    [string, Record<string, unknown>, (actorId: string) => string | undefined]
  >([
    [
      'a character without advancedBitmap',
      { a2: [bitmapOf(new FakeImageBitmap())] },
      (id) => CHARACTERS[id],
    ],
    [
      'an actor whose character the frame did not name',
      { a1: [bitmapOf(new FakeImageBitmap())] },
      () => undefined,
    ],
    [
      'a character the manifest does not have',
      { a1: [bitmapOf(new FakeImageBitmap())] },
      () => 'probe-three',
    ],
  ])(
    '沒宣告的角色: a bitmap for %s drops the draw whole (bitmap-not-allowed)',
    (_label, actors, characterOf) => {
      expect(
        checkDraw(draw(actors), FRAME_ACTORS, BITMAP_LOOK, { characterOf }),
      ).toStrictEqual({ ok: false, reason: 'bitmap-not-allowed' });
    },
  );

  it('沒宣告的角色: without the frame’s characters (checkDraw’s default) no bitmap is allowed', () => {
    expect(
      checkDraw(
        draw({ a1: [bitmapOf(new FakeImageBitmap())] }),
        FRAME_ACTORS,
        BITMAP_LOOK,
      ),
    ).toStrictEqual({ ok: false, reason: 'bitmap-not-allowed' });
  });

  it('不是 ImageBitmap: a plain object as image drops the draw whole (bitmap-not-image); one that is not plain data at all is invalid first', () => {
    expect(checkBitmaps(draw({ a1: [bitmapOf({})] }))).toStrictEqual({
      ok: false,
      reason: 'bitmap-not-image',
    });
    expect(
      checkBitmaps(
        draw({ a1: [bitmapOf({ width: 8, height: 8, close() {} })] }),
      ),
    ).toStrictEqual({ ok: false, reason: 'invalid' });
    expect(checkBitmaps(draw({ a1: [bitmapOf(new Map())] }))).toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it(`尺寸: an ImageBitmap wider or higher than ${BITMAP_MAX_SIDE} drops the draw whole (bitmap-too-large); ${BITMAP_MAX_SIDE} itself passes`, () => {
    for (const [width, height] of [
      [BITMAP_MAX_SIDE + 1, 1],
      [1, BITMAP_MAX_SIDE + 1],
    ]) {
      expect(
        checkBitmaps(
          draw({ a1: [bitmapOf(new FakeImageBitmap(width, height))] }),
        ),
      ).toStrictEqual({ ok: false, reason: 'bitmap-too-large' });
    }
    expect(
      checkBitmaps(
        draw({
          a1: [bitmapOf(new FakeImageBitmap(BITMAP_MAX_SIDE, BITMAP_MAX_SIDE))],
        }),
      ).ok,
    ).toBe(true);
  });

  it('張數: two bitmaps for one actor, or one image in two commands, drop the draw whole (too-many-bitmaps)', () => {
    const one = new FakeImageBitmap();
    expect(
      checkBitmaps(
        draw({ a1: [bitmapOf(one), bitmapOf(new FakeImageBitmap())] }),
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-bitmaps' });
    const both = bitmapLookOf(ALPHA);
    expect(
      checkDraw(
        draw({ a1: [bitmapOf(one)], a2: [bitmapOf(one)] }),
        FRAME_ACTORS,
        both,
        {
          // Both actors' characters may: only the shared image is wrong.
          characterOf: () => 'probe-one',
        },
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-bitmaps' });
  });

  it('張數: a bitmap of an actor with no allowance left (its window of BITMAP_MAX_PER_SECOND) drops the draw whole (too-many-bitmaps); the allowance is asked for that actor', () => {
    const asked: string[] = [];
    expect(
      checkBitmaps(
        draw({ a1: [bitmapOf(new FakeImageBitmap())] }),
        (actorId: string) => {
          asked.push(actorId);
          return 0;
        },
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-bitmaps' });
    expect(asked).toStrictEqual(['a1']);
    expect(
      checkBitmaps(draw({ a1: [bitmapOf(new FakeImageBitmap())] }), () => 1).ok,
    ).toBe(true);
  });

  it('the bitmap checks are the per-command step: invalid, too-many-emitters and not-own-actor come first; among an actor’s commands the first that fails decides', () => {
    const image = new FakeImageBitmap();
    expect(checkBitmaps(draw({ a2: [bitmapOf(image)], b1: [] }))).toStrictEqual(
      { ok: false, reason: 'not-own-actor' },
    );
    expect(
      checkBitmaps(draw({ a2: [bitmapOf(image), { type: 'sprite' }] })),
    ).toStrictEqual({ ok: false, reason: 'invalid' });
    expect(
      checkBitmaps(
        draw({ a2: [bitmapOf(image), ...emitters(PARTICLE_EMITTERS_MAX + 1)] }),
      ),
    ).toStrictEqual({ ok: false, reason: 'too-many-emitters' });
    expect(
      checkBitmaps(
        draw({ a1: [{ ...SPRITE, asset: 'nothing-here' }, bitmapOf({})] }),
      ),
    ).toStrictEqual({ ok: false, reason: 'unknown-asset' });
    expect(
      checkBitmaps(
        draw({ a1: [bitmapOf({}), { ...SPRITE, asset: 'nothing-here' }] }),
      ),
    ).toStrictEqual({ ok: false, reason: 'bitmap-not-image' });
  });

  it('closeBitmaps closes every ImageBitmap anywhere in a message once, in lists, objects, Maps and Sets, cycles included', () => {
    const images = Array.from({ length: 5 }, () => new FakeImageBitmap());
    const cycle: Record<string, unknown> = { image: images[4] };
    cycle.self = cycle;
    closeBitmaps({
      type: 'draw',
      actors: {
        a1: [bitmapOf(images[0] as object), bitmapOf(images[0] as object)],
      },
      deep: [[{ x: images[1] }]],
      map: new Map<unknown, unknown>([[images[2], 1]]),
      set: new Set([images[3]]),
      cycle,
      bytes: new Uint8Array(4),
    });
    expect(images.map((image) => image.closes)).toStrictEqual([1, 1, 1, 1, 1]);
    closeBitmaps(null);
    closeBitmaps('draw');
  });
});

describe('the bitmap window', () => {
  it(`counts each actor’s bitmaps of the last ${BITMAP_WINDOW_MS} ms (one second): ${BITMAP_MAX_PER_SECOND} (the ${TICK_HZ} ticks a second and 6 more for jitter) in it leave no allowance; as they leave it, it comes back`, () => {
    const clock = fakeClock();
    const window = createBitmapWindow(clock.monotonic);
    expect(BITMAP_WINDOW_MS).toBe(1000);
    expect(BITMAP_MAX_PER_SECOND).toBe(TICK_HZ + 6);

    for (let i = 0; i < BITMAP_MAX_PER_SECOND; i += 1) {
      expect(window.allowance('a1')).toBe(BITMAP_MAX_PER_SECOND - i);
      window.take(['a1']);
      clock.advance(10);
    }
    expect(window.allowance('a1')).toBe(0);
    expect(window.allowance('a2')).toBe(BITMAP_MAX_PER_SECOND);

    // The first was taken BITMAP_MAX_PER_SECOND * 10 ms ago: it leaves the
    // window exactly BITMAP_WINDOW_MS after it was taken.
    const since = BITMAP_MAX_PER_SECOND * 10;
    clock.advance(BITMAP_WINDOW_MS - since - 1);
    expect(window.allowance('a1')).toBe(0);
    clock.advance(1);
    expect(window.allowance('a1')).toBe(1);
    clock.advance(BITMAP_WINDOW_MS);
    expect(window.allowance('a1')).toBe(BITMAP_MAX_PER_SECOND);
  });

  it('a pack drawing one every tick, its answers coming back as late as a tick, is never out of allowance', () => {
    const clock = fakeClock();
    const window = createBitmapWindow(clock.monotonic);
    let at = 0;
    for (let tick = 0; tick < 10 * TICK_HZ; tick += 1) {
      // Each answer comes 1 to 30 ms after its tick, on no pattern.
      const due = (tick * 1000) / TICK_HZ + 1 + ((tick * 7919) % 30);
      clock.advance(Math.max(0, due - at));
      at = Math.max(at, due);
      expect(window.allowance('a1'), `tick ${tick}`).toBeGreaterThan(0);
      window.take(['a1']);
    }
  });
});

describe('I/O matrix', () => {
  beforeEach(() => {
    stubImageBitmap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A ready ALPHA (bitmap look) with a1 (probe-one) and a2 (probe-two), its first frame out. */
  async function bitmapHost() {
    const t = setup({ bitmap: true });
    await showReady(t, [actor('a1', ALPHA), actor('a2', ALPHA, 'probe-two')]);
    t.host.tick({ t: 0, events: [] });
    return { ...t, alpha: frameOf(t, ALPHA) };
  }

  it('沒宣告的角色: before its init a pack with advancedBitmap characters gets their ids, for its bootstrap alone, once; a pack without gets nothing more', async () => {
    const t = await bitmapHost();

    expect(t.alpha.posted[0]).toStrictEqual(
      sandboxBitmapCharactersMessage(['probe-one']),
    );
    expect(types(t.alpha)).toStrictEqual([
      'sandbox.bitmap-characters',
      'init',
      'frame',
    ]);
    t.alpha.handlers.onMessage(draw({}, 0));
    t.host.tick({ t: 33, events: [] });
    expect(
      types(t.alpha).filter((type) => type.startsWith('sandbox.')),
    ).toHaveLength(1);
  });

  it('bitmap 出現: a draw with a bitmap that passes is the latest draw, its ImageBitmap open', async () => {
    const t = await bitmapHost();
    const image = new FakeImageBitmap(64, 64);

    t.alpha.handlers.onMessage(
      draw({ a1: [bitmapOf(image)], a2: [SPRITE] }, 0),
    );

    expect(t.host.drawOf(ALPHA)?.actors.get('a1')).toStrictEqual([
      bitmapOf(image),
    ]);
    expect(image.closes).toBe(0);
    expect(
      t.logs.filter((entry) => entry.kind === 'messages-dropped'),
    ).toStrictEqual([]);
  });

  it.each<[string, (images: FakeImageBitmap[]) => unknown, string]>([
    [
      'a bitmap for probe-two (沒宣告的角色)',
      ([one]) => ({ a2: [bitmapOf(one as object)] }),
      'bitmap-not-allowed',
    ],
    [
      'a plain object as image (不是 ImageBitmap)',
      () => ({ a1: [bitmapOf({})] }),
      'bitmap-not-image',
    ],
    [
      `a bitmap wider than ${BITMAP_MAX_SIDE} (尺寸)`,
      () => ({ a1: [bitmapOf(new FakeImageBitmap(BITMAP_MAX_SIDE + 1, 8))] }),
      'bitmap-too-large',
    ],
    [
      'two bitmaps for one actor (張數)',
      ([one, two]) => ({
        a1: [bitmapOf(one as object), bitmapOf(two as object)],
      }),
      'too-many-bitmaps',
    ],
    [
      'a sprite of an unknown asset beside a bitmap',
      ([one]) => ({
        a1: [bitmapOf(one as object)],
        a2: [{ ...SPRITE, asset: 'elsewhere' }],
      }),
      'unknown-asset',
    ],
  ])(
    '不合規: a draw with %s is dropped whole with one line naming the pack, and every ImageBitmap in it closed',
    async (_label, actors, reason) => {
      const t = await bitmapHost();
      const images = [new FakeImageBitmap(), new FakeImageBitmap()];
      const data = draw(actors(images) as Record<string, unknown>, 0);
      const inside = [
        ...JSON.stringify(data, (_key, value: unknown) =>
          value instanceof FakeImageBitmap
            ? `#${images.indexOf(value)}`
            : value,
        ).matchAll(/"#(\d)"/g),
      ].map((match) => Number(match[1]));
      t.logs.length = 0;

      t.alpha.handlers.onMessage(data);

      expect(t.logs).toStrictEqual([
        { kind: 'messages-dropped', packId: ALPHA, reason, count: 1 },
      ]);
      expect(t.host.drawOf(ALPHA)).toBeUndefined();
      for (const index of new Set(inside)) {
        expect(images[index]?.closes).toBe(1);
      }
    },
  );

  it('張數: one image in two actors’ commands drops the draw, closing it once', async () => {
    const t = setup({ bitmap: true });
    await showReady(t, [actor('a1', ALPHA), actor('a3', ALPHA)]);
    t.host.tick({ t: 0, events: [] });
    const image = new FakeImageBitmap();

    frameOf(t, ALPHA).handlers.onMessage(
      draw({ a1: [bitmapOf(image)], a3: [bitmapOf(image)] }, 0),
    );

    expect(t.logs.at(-1)).toMatchObject({ reason: 'too-many-bitmaps' });
    expect(image.closes).toBe(1);
  });

  it('不合規: a draw refused for the message rate, or stale, has its ImageBitmaps closed too', async () => {
    const t = await bitmapHost();
    const stale = new FakeImageBitmap();
    t.alpha.handlers.onMessage(draw({ a1: [bitmapOf(stale)] }, 9));
    expect(stale.closes).toBe(1);

    for (let i = 0; i < PACK_MESSAGE_RATE_LIMIT; i += 1) {
      t.alpha.handlers.onMessage({
        type: 'stage.hold',
        actorId: 'a1',
        on: true,
      });
    }
    const limited = new FakeImageBitmap();
    t.alpha.handlers.onMessage(draw({ a1: [bitmapOf(limited)] }, 0));
    expect(limited.closes).toBe(1);
    expect(
      t.logs
        .filter((entry) => entry.kind === 'messages-dropped')
        .map((entry) => (entry as { reason: string }).reason),
    ).toStrictEqual(['stale-draw', 'rate-limited']);
  });

  it('不合規: a message that comes once its sandbox failed or was removed has its ImageBitmaps closed', async () => {
    const t = await bitmapHost();
    t.alpha.handlers.onMessage({ type: 'sandbox.fault', fault: 'error' });
    const late = new FakeImageBitmap();

    t.alpha.handlers.onMessage(draw({ a1: [bitmapOf(late)] }, 0));

    expect(late.closes).toBe(1);
  });

  it(`張數: ${BITMAP_MAX_PER_SECOND} bitmaps of one actor within the window pass; one more drops the draw (too-many-bitmaps) and is closed; another actor is counted apart; once the window moved on, they pass again`, async () => {
    const t = setup({ bitmap: true });
    // a1 and a3 both play probe-one, which has advancedBitmap.
    await showReady(t, [actor('a1', ALPHA), actor('a3', ALPHA)]);
    t.host.tick({ t: 0, events: [] });
    const alpha = frameOf(t, ALPHA);
    let seq = 0;
    /** Answers the frame in flight with `actors`; the next tick is 10 ms on. */
    const answer = (actors: Record<string, unknown>): void => {
      alpha.handlers.onMessage(draw(actors, seq));
      seq += 1;
      t.clock.advance(10);
      t.host.tick({ t: seq * 10, events: [] });
    };
    const imageOf = (actorId: string): unknown =>
      (t.host.drawOf(ALPHA)?.actors.get(actorId)?.[0] as { image?: unknown })
        ?.image;
    const kept: FakeImageBitmap[] = [];
    for (let i = 0; i < BITMAP_MAX_PER_SECOND; i += 1) {
      const image = new FakeImageBitmap();
      kept.push(image);
      answer({ a1: [bitmapOf(image)], a3: [] });
      expect(imageOf('a1')).toBe(image);
    }
    t.logs.length = 0;
    const over = new FakeImageBitmap();
    answer({ a1: [bitmapOf(over)], a3: [] });

    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'too-many-bitmaps',
        count: 1,
      },
    ]);
    expect(over.closes).toBe(1);
    expect(kept.every((image) => image.closes === 0)).toBe(true);
    expect(imageOf('a1')).toBe(kept.at(-1));

    // a3, in the same window: none of a1's count for it.
    const other = new FakeImageBitmap();
    answer({ a1: [], a3: [bitmapOf(other)] });
    expect(imageOf('a3')).toBe(other);
    expect(other.closes).toBe(0);

    // The dropped one does not count; the window moves on.
    t.clock.advance(BITMAP_WINDOW_MS);
    const again = new FakeImageBitmap();
    answer({ a1: [bitmapOf(again)], a3: [] });
    expect(imageOf('a1')).toBe(again);
    expect(again.closes).toBe(0);
  });

  it('抖動: a pack drawing a bitmap every tick, its answers bunched up by a stall (the second taken about 2 ticks late, the ticks after it at once, then back on the grid), is never judged too-many-bitmaps', async () => {
    const t = await bitmapHost();
    // The first frame went out now: the times below count from it.
    const start = t.clock.monotonic();
    const period = 1000 / TICK_HZ;
    const at = (ms: number): void => {
      t.clock.advance(start + ms - t.clock.monotonic());
    };
    const sent: FakeImageBitmap[] = [];
    /** Answers the frame in flight at `ms` with a fresh bitmap for a1. */
    const answerAt = (ms: number): void => {
      at(ms);
      const out = t.alpha.posted.findLast(
        (message) => (message as { type: string }).type === 'frame',
      ) as { seq: number };
      const image = new FakeImageBitmap();
      sent.push(image);
      t.alpha.handlers.onMessage(
        draw({ a1: [bitmapOf(image)], a2: [] }, out.seq),
      );
      const shown = t.host.drawOf(ALPHA)?.actors.get('a1')?.[0] as
        | { image?: unknown }
        | undefined;
      expect(shown?.image, `the answer at ${ms} ms`).toBe(image);
    };
    const tickAt = (ms: number): void => {
      at(ms);
      t.host.tick({ t: ms, events: [] });
    };

    answerAt(3);
    tickAt(period);
    // The stage stalls until 99 ms: no tick at 2 periods, and the answer
    // to the second frame waits until then. The late tick keeps its grid
    // (world.ts), so the next comes at once.
    answerAt(99);
    tickAt(99);
    answerAt(101);
    tickAt(101);
    answerAt(103);
    // Back on the grid, each answer 3 ms after its tick, for 3 seconds.
    for (let tick = 4; tick <= 3 * TICK_HZ; tick += 1) {
      tickAt(tick * period);
      answerAt(tick * period + 3);
    }

    expect(sent).toHaveLength(3 * TICK_HZ + 1);
    expect(
      t.logs.filter((entry) => entry.kind === 'messages-dropped'),
    ).toStrictEqual([]);
    expect(sent.every((image) => image.closes === 0)).toBe(true);
  });

  it('不合規: an ImageBitmap passed in a stage.* call (dropped as invalid, or for the message rate) is closed at once', async () => {
    const t = await bitmapHost();
    const asHold = new FakeImageBitmap();
    const asShot = new FakeImageBitmap();
    t.alpha.handlers.onMessage({
      type: 'stage.hold',
      actorId: 'a1',
      on: asHold,
    });
    t.alpha.handlers.onMessage({
      type: 'stage.fire',
      actorId: 'a1',
      target: 'a2',
      object: { image: asShot },
    });
    expect([asHold.closes, asShot.closes]).toStrictEqual([1, 1]);

    // Two messages so far: the rest of the rate, then one over it.
    for (let i = 2; i < PACK_MESSAGE_RATE_LIMIT; i += 1) {
      t.alpha.handlers.onMessage({
        type: 'stage.hold',
        actorId: 'a1',
        on: true,
      });
    }
    const limited = new FakeImageBitmap();
    t.alpha.handlers.onMessage({
      type: 'stage.face',
      actorId: 'a1',
      direction: limited,
    });
    expect(limited.closes).toBe(1);
    expect(
      t.logs
        .filter((entry) => entry.kind === 'messages-dropped')
        .map((entry) => (entry as { reason: string }).reason),
    ).toStrictEqual(['invalid', 'rate-limited']);
  });

  it('釋放: a kept draw replaced by the next before it was shown, or gone with its sandbox, is left to the renderer and the garbage collector: pack-host closes none of its bitmaps', async () => {
    const t = await bitmapHost();
    const first = new FakeImageBitmap();
    const second = new FakeImageBitmap();
    t.alpha.handlers.onMessage(draw({ a1: [bitmapOf(first)] }, 0));
    t.host.tick({ t: 33, events: [] });

    t.alpha.handlers.onMessage(draw({ a1: [bitmapOf(second)] }, 1));
    expect(t.host.drawOf(ALPHA)?.actors.get('a1')).toStrictEqual([
      bitmapOf(second),
    ]);
    expect([first.closes, second.closes]).toStrictEqual([0, 0]);

    t.alpha.handlers.onMessage({ type: 'sandbox.fault', fault: 'error' });
    expect(t.host.drawOf(ALPHA)).toBeUndefined();
    expect([first.closes, second.closes]).toStrictEqual([0, 0]);
  });

  it('沒宣告的角色: a sandbox made again (its actors left, it went idle, one came back) gets the bitmap characters again, before its init', async () => {
    const t = await bitmapHost();
    t.host.onView(view([]));
    t.clock.advance(SANDBOX_IDLE_MS);
    expect(t.alpha.removed).toBe(true);

    await showReady(t, [actor('a3', ALPHA)]);
    const again = frameOf(t, ALPHA);
    expect(again).not.toBe(t.alpha);
    t.host.tick({ t: SANDBOX_IDLE_MS, events: [] });

    expect(types(again)).toStrictEqual([
      'sandbox.bitmap-characters',
      'init',
      'frame',
    ]);
    expect(again.posted[0]).toStrictEqual(
      sandboxBitmapCharactersMessage(['probe-one']),
    );
  });

  it('加入與移出: a bitmap for an actor that left after its frame is still allowed (its character as that frame had it)', async () => {
    const t = await bitmapHost();
    t.host.onView(view([actor('a2', ALPHA, 'probe-two')]));
    t.host.tick({ t: 33, events: [{ type: 'leave', actorId: 'a1' }] });
    expect(types(t.alpha).at(-1)).toBe('despawn');
    const image = new FakeImageBitmap();

    t.alpha.handlers.onMessage(draw({ a1: [bitmapOf(image)], a2: [] }, 0));

    expect(t.host.drawOf(ALPHA)?.actors.get('a1')).toStrictEqual([
      bitmapOf(image),
    ]);
    expect(image.closes).toBe(0);
  });
});
