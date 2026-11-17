/**
 * pack-host's side of the stage messages and draws (Story 3.6): the check
 * of a `draw` (draw-rules.ts), and, around one pack-host with fake
 * iframes, a fake main, fake looks and a fake clock, what each tick posts
 * to a ready sandbox, which draws it keeps, and what it logs.
 */
import { describe, expect, it, vi } from 'vitest';
import { packLook, type PackLook } from '../../src/overlay/looks';
import {
  checkDraw,
  countDrawCommands,
  type DrawCheckLook,
} from '../../src/overlay/pack-host/draw-rules';
import {
  createPackHost,
  type PackHostApi,
  type SandboxFrameHandlers,
} from '../../src/overlay/pack-host/host';
import {
  DRAW_MAX_BYTES,
  DRAW_MAX_COMMANDS,
  PACK_DROP_LOG_INTERVAL_MS,
  PACK_MESSAGE_RATE_LIMIT,
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
} from '../../src/shared/sandbox';
import type { StageCharacters, StageView } from '../../src/shared/stage-view';
import { contractManifest } from '../helpers/awpet';
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
      skipped: new Set(),
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

  it('粒子與 bitmap: particles and bitmap commands are left out and named; the rest is kept', () => {
    expect(
      checkDraw(
        draw({ a1: [PARTICLES, SPRITE], a2: [BITMAP] }),
        FRAME_ACTORS,
        LOOK,
      ),
    ).toStrictEqual({
      ok: true,
      actors: new Map([
        ['a1', [SPRITE]],
        ['a2', []],
      ]),
      skipped: new Set(['particles', 'bitmap']),
    });
  });

  it('漏回: a draw leaving out one of the frame’s actors passes, without it', () => {
    const check = checkDraw(draw({ a1: [SPRITE] }), FRAME_ACTORS, LOOK);
    expect(check.ok && [...check.actors.keys()]).toStrictEqual(['a1']);
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

function setup(options: { looks?: boolean } = {}) {
  const clock = fakeClock();
  const logs: PackLogEntry[] = [];
  const frames = new Map<string, FakeFrame>();
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
  };
  const looks = new Map<string, PackLook>(
    options.looks === false
      ? []
      : [
          [ALPHA, lookOf(ALPHA)],
          [BRAVO, lookOf(BRAVO)],
        ],
  );
  const host = createPackHost({
    api,
    frames: {
      create(handlers) {
        const frame: FakeFrame = { handlers, posted: [], removed: false };
        frames.set(asked.shift() ?? '', frame);
        return {
          hand() {},
          post(message) {
            expect(stageMessageSchema.safeParse(message).success).toBe(true);
            frame.posted.push(structuredClone(message));
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
  return { host, clock, logs, frames, looks };
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

  it('一包變慢: a pack that never answers stops getting frames; the other goes on getting them and its draws are taken', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);
    const alpha = frameOf(t, ALPHA);
    const bravo = frameOf(t, BRAVO);

    for (let tick = 0; tick < 5; tick += 1) {
      t.host.tick({ t: tick * 33, events: [] });
      bravo.handlers.onMessage(draw({ b1: [{ ...SPRITE, x: tick }] }, tick));
    }

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

  it('粒子與 bitmap: they are left out of the draw, the rest is drawn, and each type is logged once per pack', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    const alpha = frameOf(t, ALPHA);
    t.logs.length = 0;
    for (let seq = 0; seq < 3; seq += 1) {
      t.host.tick({ t: seq * 33, events: [] });
      alpha.handlers.onMessage(
        draw({ a1: [PARTICLES, SPRITE, ...(seq === 2 ? [BITMAP] : [])] }, seq),
      );
    }

    expect(t.host.drawOf(ALPHA)?.actors.get('a1')).toStrictEqual([SPRITE]);
    expect(t.logs).toStrictEqual([
      { kind: 'commands-skipped', packId: ALPHA, command: 'particles' },
      { kind: 'commands-skipped', packId: ALPHA, command: 'bitmap' },
    ]);
  });

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
