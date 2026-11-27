/**
 * The Worker bootstrap's side of the stage messages (Story 3.6): each
 * message checked against stageMessageSchema and handed to the pack's
 * handler, the pack's own actors kept for `stage.random`, `frame`'s answer
 * wrapped as `draw` (or `sandbox.no-draw`), and run() listening on the port
 * once it comes, answering pack-host's ping with a pong itself (Story
 * 3.9). With fake handlers and ports; the contract test pack's entry is
 * evaluated here without SES (the real boot is in build.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bitmapBrandOf,
  bitmapCharactersOf,
  COPY_MAX_DEPTH,
  copyPlain,
  countConsole,
  NO_BITMAP_BRAND,
  createStage,
  type DrawReply,
  isPingMessage,
  type NoDrawReport,
  type OwnActors,
  routeStageMessage,
  run,
} from '../../src/sandbox/worker-bootstrap';
import {
  drawMessageSchema,
  type StageMessage,
} from '../../src/shared/pack-api';
import { DRAW_MAX_BYTES, DRAW_MAX_COMMANDS } from '../../src/shared/constants';
import { imageBitmapsIn, jsonBytes } from '../../src/shared/draw-size';
import {
  sandboxBitmapCharactersMessage,
  sandboxPingMessage,
  sandboxReportSchema,
} from '../../src/shared/sandbox';
import {
  FakeImageBitmap,
  fakeOffscreenCanvas,
  stubImageBitmap,
} from '../helpers/fake-bitmaps';

const CONTRACT_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packs/contract-pack/contract-pack/entry.js',
);

const INIT: StageMessage = {
  type: 'init',
  actors: [
    {
      own: true,
      actorId: 'a1',
      characterId: 'probe-one',
      params: { glow: true, bob: 2, skin: 'probe-one-plain' },
      state: 'thinking',
      displayName: 'one',
    },
    { own: false, actorId: 'b1', state: 'idle' },
  ],
};

const SPAWN: StageMessage = {
  type: 'spawn',
  actorId: 'a2',
  characterId: 'probe-two',
  params: { 'blink-every': 3, mood: 'calm' },
  state: 'done',
  displayName: null,
};

function frame(seq: number, actorIds: readonly string[]): StageMessage {
  return {
    type: 'frame',
    seq,
    t: seq * 33,
    dt: seq === 0 ? 0 : 33,
    actors: actorIds.map((actorId) => ({ actorId, state: 'working' })),
    events: [],
  };
}

/** Routes `messages` to `handlers`; what was replied, and the own actors. */
function route(
  handlers: object,
  messages: readonly unknown[],
  ownActors: OwnActors = new Map(),
  reply: (message: DrawReply | NoDrawReport) => void = () => {},
) {
  const replies: (DrawReply | NoDrawReport)[] = [];
  for (const message of messages) {
    routeStageMessage(message, handlers, ownActors, (answer) => {
      reply(answer);
      replies.push(answer);
    });
  }
  return { replies, ownActors };
}

/** The contract test pack's handlers, with a stage that knows `ownActors`. */
function contractHandlers(ownActors: OwnActors): object {
  const factory = vm.runInThisContext(readFileSync(CONTRACT_ENTRY, 'utf8')) as (
    stage: object,
  ) => object;
  return factory(
    createStage(
      (value) => value,
      () => {},
      ownActors,
    ),
  );
}

describe('routeStageMessage', () => {
  it('hands each message to its handler, as parsed, and nothing for a message without one', () => {
    const calls: unknown[][] = [];
    const handlers = {
      init(message: unknown) {
        calls.push(['init', message]);
      },
      meta(message: unknown) {
        calls.push(['meta', message]);
      },
    };

    route(handlers, [
      INIT,
      SPAWN,
      { type: 'meta', actorId: 'a1', displayName: 'renamed' },
    ]);

    expect(calls).toStrictEqual([
      ['init', INIT],
      ['meta', { type: 'meta', actorId: 'a1', displayName: 'renamed' }],
    ]);
  });

  it.each<[string, unknown]>([
    ['not an object', 'frame'],
    ['an unknown type', { type: 'shout' }],
    ['a frame with a negative seq', { ...frame(0, ['a1']), seq: -1 }],
    ['a spawn with a session key', { ...SPAWN, sessionKey: 'claude-code:x' }],
    [
      'an init with an actor twice',
      {
        type: 'init',
        actors: [
          ...(INIT.type === 'init' ? INIT.actors : []),
          { own: false, actorId: 'b1', state: 'idle' },
        ],
      },
    ],
  ])('ignores a message that is %s: no handler, no answer', (_label, data) => {
    const handler = vi.fn(() => ({}));
    const handlers = { init: handler, spawn: handler, frame: handler };

    const { replies, ownActors } = route(handlers, [data]);

    expect(handler).not.toHaveBeenCalled();
    expect(replies).toStrictEqual([]);
    expect([...ownActors.keys()]).toStrictEqual([]);
  });

  it("keeps the pack's own actors: init and spawn before the handler runs, despawn after", () => {
    const seen: string[][] = [];
    const ownActors: OwnActors = new Map([
      ['stale', { characterId: 'probe-one' }],
    ]);
    const handlers = {
      init() {
        seen.push(['init', ...ownActors.keys()]);
      },
      spawn() {
        seen.push(['spawn', ...ownActors.keys()]);
      },
      despawn() {
        seen.push(['despawn', ...ownActors.keys()]);
      },
    };

    route(
      handlers,
      [INIT, SPAWN, { type: 'despawn', actorId: 'a1' }],
      ownActors,
    );

    expect(seen).toStrictEqual([
      ['init', 'a1'],
      ['spawn', 'a1', 'a2'],
      ['despawn', 'a1', 'a2'],
    ]);
    expect([...ownActors.keys()]).toStrictEqual(['a2']);
  });

  it('keeps each own actor’s character, as init and spawn name it', () => {
    const ownActors: OwnActors = new Map();

    route({}, [INIT, SPAWN], ownActors);

    expect(ownActors).toStrictEqual(
      new Map([
        ['a1', { characterId: 'probe-one' }],
        ['a2', { characterId: 'probe-two' }],
      ]),
    );
  });

  it('stage.random answers for the own actors the messages named, and for no other pack’s', () => {
    const ownActors: OwnActors = new Map();
    const stage = createStage(
      (value) => value,
      () => {},
      ownActors,
    ) as {
      random(actorId: string): number;
    };
    const draws: number[] = [];
    const handlers = {
      init() {
        draws.push(stage.random('a1'));
      },
    };

    route(handlers, [INIT], ownActors);

    expect(draws).toHaveLength(1);
    expect(() => stage.random('b1')).toThrow(TypeError);
  });

  it("answers a frame with { type: 'draw', seq, actors: <what it returned> }", () => {
    const handlers = {
      frame(message: { seq: number }) {
        return { a1: [{ type: 'sprite', asset: 'x', x: message.seq, y: 0 }] };
      },
    };

    const { replies } = route(handlers, [frame(4, ['a1'])]);

    expect(replies).toStrictEqual([
      {
        type: 'draw',
        seq: 4,
        actors: { a1: [{ type: 'sprite', asset: 'x', x: 4, y: 0 }] },
      },
    ]);
  });

  it.each<[string, object, NoDrawReport['reason']]>([
    ['no frame handler', {}, 'no-frame-handler'],
    ['a frame that is not a function', { frame: 3 }, 'no-frame-handler'],
    [
      'a frame that throws',
      {
        frame() {
          throw new Error('boom');
        },
      },
      'frame-threw',
    ],
    [
      'a frame getter that throws',
      Object.defineProperty({}, 'frame', {
        get() {
          throw new Error('boom');
        },
      }),
      'frame-threw',
    ],
  ])('answers %s with sandbox.no-draw', (_label, handlers, reason) => {
    const { replies } = route(handlers, [frame(2, ['a1'])]);

    expect(replies).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 2, reason },
    ]);
    expect(sandboxReportSchema.safeParse(replies[0]).success).toBe(true);
  });

  it('a draw that cannot be sent (the port throws on it) is answered with sandbox.no-draw instead; the Worker goes on', () => {
    const handlers = {
      frame: () => ({ a1: [() => 1] }),
    };
    const sent: unknown[] = [];
    const reply = (message: DrawReply | NoDrawReport) => {
      structuredClone(message);
      sent.push(message);
    };

    for (const seq of [0, 1]) {
      routeStageMessage(frame(seq, ['a1']), handlers, new Map(), reply);
    }

    expect(sent).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 0, reason: 'draw-not-cloneable' },
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-not-cloneable' },
    ]);
  });

  it(`超過上限: a draw over ${DRAW_MAX_BYTES} bytes or ${DRAW_MAX_COMMANDS} commands is not posted: the frame is answered with sandbox.no-draw`, () => {
    const sprite = { type: 'sprite', asset: 'x', x: 0, y: 0 };
    const answers = {
      big: { a1: [{ ...sprite, asset: 'x'.repeat(DRAW_MAX_BYTES) }] },
      many: {
        a1: Array.from({ length: DRAW_MAX_COMMANDS }, () => sprite),
        a2: [sprite],
      },
      atLimit: { a1: Array.from({ length: DRAW_MAX_COMMANDS }, () => sprite) },
    };
    let next: keyof typeof answers = 'big';
    const handlers = { frame: () => answers[next] };

    const replies: unknown[] = [];
    for (const [seq, which] of (
      ['big', 'many', 'atLimit'] as const
    ).entries()) {
      next = which;
      routeStageMessage(
        frame(seq, ['a1', 'a2']),
        handlers,
        new Map(),
        (reply) => {
          replies.push(reply);
        },
      );
    }

    expect(replies.slice(0, 2)).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 0, reason: 'draw-too-large' },
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-too-many-commands' },
    ]);
    expect(replies[2]).toMatchObject({ type: 'draw', seq: 2 });
  });

  it('a draw with a getter that throws while it is measured is answered as draw-not-cloneable', () => {
    const handlers = {
      frame: () =>
        Object.defineProperty({}, 'a1', {
          enumerable: true,
          get() {
            throw new Error('boom');
          },
        }),
    };

    const { replies } = route(handlers, [frame(3, ['a1'])]);

    expect(replies).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 3, reason: 'draw-not-cloneable' },
    ]);
  });

  it.each<[string, unknown]>([
    ['a frame with motion (API 1.1)', { ...frame(5, ['a1']), motion: {} }],
    [
      'a frame without t',
      { type: 'frame', seq: 5, dt: 0, actors: [], events: [] },
    ],
    [
      'a frame with a bad actor',
      { ...frame(5, []), actors: [{ actorId: 'a1' }] },
    ],
  ])(
    '在途: %s does not reach the pack, but its seq is answered with sandbox.no-draw (invalid-frame), so the overlay does not wait',
    (_label, data) => {
      const handler = vi.fn(() => ({}));

      const { replies } = route({ frame: handler }, [data]);

      expect(handler).not.toHaveBeenCalled();
      expect(replies).toStrictEqual([
        { type: 'sandbox.no-draw', seq: 5, reason: 'invalid-frame' },
      ]);
      expect(sandboxReportSchema.safeParse(replies[0]).success).toBe(true);
    },
  );

  it.each<[string, unknown]>([
    ['a frame with a negative seq', { ...frame(0, ['a1']), seq: -1 }],
    ['a frame with a fractional seq', { ...frame(0, ['a1']), seq: 1.5 }],
    ['a frame with no seq', { type: 'frame' }],
    ['not a frame', { type: 'spawn', seq: 4 }],
  ])('%s, its seq unreadable as a frame’s, gets no answer', (_label, data) => {
    const { replies } = route({ frame: () => ({}) }, [data]);
    expect(replies).toStrictEqual([]);
  });

  it('a handler other than frame that throws stops nothing: the next message is handled', () => {
    const handlers = {
      init() {
        throw new Error('boom');
      },
      frame: () => ({}),
    };

    const { replies, ownActors } = route(handlers, [INIT, frame(0, ['a1'])]);

    expect([...ownActors.keys()]).toStrictEqual(['a1']);
    expect(replies).toStrictEqual([{ type: 'draw', seq: 0, actors: {} }]);
  });
});

describe('I/O matrix', () => {
  it("出現: the contract test pack answers init, spawn and frames with draws that pass drawMessageSchema, one per frame, each actor's look", () => {
    const ownActors: OwnActors = new Map();
    const handlers = contractHandlers(ownActors);

    const { replies } = route(
      handlers,
      [INIT, frame(0, ['a1']), SPAWN, frame(1, ['a1', 'a2'])],
      ownActors,
    );

    expect(replies.map((reply) => reply.type)).toStrictEqual(['draw', 'draw']);
    const [first, second] = replies.map((reply) =>
      drawMessageSchema.parse(reply),
    );
    expect(first?.seq).toBe(0);
    expect(Object.keys(first?.actors ?? {})).toStrictEqual(['a1']);
    // Working, glow on: a sprite of its skin (and no particles: not thinking).
    expect(first?.actors.a1).toStrictEqual([
      expect.objectContaining({ type: 'sprite', asset: 'probe-one-plain' }),
    ]);
    expect(second?.seq).toBe(1);
    expect(Object.keys(second?.actors ?? {})).toStrictEqual(['a1', 'a2']);
    expect(second?.actors.a2).toStrictEqual([
      expect.objectContaining({ type: 'sprite', asset: 'probe-two-sheet' }),
    ]);
  });
});

/** A fake Worker scope with SES already locked down, for run(). */
function lockedScope(handlers: object | (() => never)) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const scope: Record<string, unknown> = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    console: { log: () => {} },
    lockdown: () => {
      scope.harden = <T>(value: T): T => value;
      scope.Compartment = class {
        evaluate() {
          return () => (typeof handlers === 'function' ? handlers() : handlers);
        }
      };
    },
  };
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  return { scope, emit };
}

/** A fake MessagePort: what is posted on it, and a way to send it a message. */
function fakePort() {
  const sent: unknown[] = [];
  let listener: ((event: { data: unknown }) => void) | undefined;
  let started = false;
  return {
    sent,
    port: {
      postMessage(message: unknown) {
        sent.push(structuredClone(message));
      },
      addEventListener(
        _type: 'message',
        next: (event: { data: unknown }) => void,
      ) {
        listener = next;
      },
      start() {
        started = true;
      },
    },
    started: () => started,
    send(data: unknown) {
      listener?.({ data });
    },
  };
}

describe('run: the stage messages on the port', () => {
  it('once the port has come, the stage’s messages go to the handlers and the frame’s draw goes back on it', () => {
    const worker = lockedScope({ frame: () => ({ a1: [] }) });
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const port = fakePort();

    worker.emit('message', { data: { type: 'port' }, ports: [port.port] });
    port.send(INIT);
    port.send(frame(0, ['a1']));

    expect(port.started()).toBe(true);
    expect(port.sent).toStrictEqual([
      expect.objectContaining({ type: 'sandbox.ready' }),
      { type: 'draw', seq: 0, actors: { a1: [] } },
    ]);
  });

  it('心跳: a ping on the port is answered at once with a pong on it, by the bootstrap: no handler of the pack sees it (not even one named after it), and it comes between the answers to the stage messages around it; a message that only looks like a ping is ignored', () => {
    const seen: string[] = [];
    const worker = lockedScope({
      init: () => {
        seen.push('init');
      },
      frame: () => {
        seen.push('frame');
        return { a1: [] };
      },
      ['sandbox.ping']: () => {
        seen.push('internal');
      },
    });
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const port = fakePort();
    worker.emit('message', { data: { type: 'port' }, ports: [port.port] });

    port.send(sandboxPingMessage());
    port.send({ ...sandboxPingMessage(), seq: 1 });
    port.send({ type: 'sandbox.pings' });
    port.send(INIT);
    port.send(frame(0, ['a1']));
    port.send(sandboxPingMessage());
    port.send(frame(1, ['a1']));

    expect(seen).toStrictEqual(['init', 'frame', 'frame']);
    expect(port.sent).toStrictEqual([
      expect.objectContaining({ type: 'sandbox.ready' }),
      { type: 'sandbox.pong' },
      { type: 'draw', seq: 0, actors: { a1: [] } },
      { type: 'sandbox.pong' },
      { type: 'draw', seq: 1, actors: { a1: [] } },
    ]);
    // The overlay takes it as a report.
    expect(sandboxReportSchema.safeParse(port.sent[1]).success).toBe(true);
  });

  it('心跳: the pong is the bootstrap’s, not the pack’s: a sandbox whose factory threw still answers a ping', () => {
    const worker = lockedScope(() => {
      throw new Error('factory');
    });
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const port = fakePort();
    worker.emit('message', { data: { type: 'port' }, ports: [port.port] });

    port.send(sandboxPingMessage());

    expect(port.sent).toStrictEqual([
      expect.objectContaining({ type: 'sandbox.failed' }),
      { type: 'sandbox.pong' },
    ]);
  });

  it('isPingMessage takes exactly { type: "sandbox.ping" }, as pack-host makes it', () => {
    expect(isPingMessage(sandboxPingMessage())).toBe(true);
    for (const other of [
      'sandbox.ping',
      null,
      {},
      { type: 'sandbox.pong' },
      { type: 'sandbox.ping', seq: 0 },
      [{ type: 'sandbox.ping' }],
    ]) {
      expect(isPingMessage(other)).toBe(false);
    }
  });

  it('a sandbox that failed to boot takes no stage message', () => {
    const worker = lockedScope(() => {
      throw new Error('factory');
    });
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const port = fakePort();

    worker.emit('message', { data: { type: 'port' }, ports: [port.port] });
    port.send(INIT);
    port.send(frame(0, ['a1']));

    expect(port.sent).toStrictEqual([
      expect.objectContaining({
        type: 'sandbox.failed',
        reason: 'factory-threw',
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Bitmaps (Story 3.6's last part): FakeImageBitmap stands in for the
// global ImageBitmap, a fake OffscreenCanvas for the Worker's. The Worker
// tells an ImageBitmap by the brand check run() hands routeStageMessage
// (bitmapBrandOf, here of the stubbed global).

/** A bitmap command of `image`. */
function bitmapCommand(image: object): Record<string, unknown> {
  return { type: 'bitmap', image, x: -32, y: -96, width: 64, height: 64 };
}

/** A list nested `depth` lists deep (itself the first): [[[…]]]. */
function nestedLists(depth: number): unknown[] {
  let list: unknown[] = [];
  for (let i = 1; i < depth; i += 1) {
    list = [list];
  }
  return list;
}

/** Own actors `actorIds`, each playing probe-one (advancedBitmap). */
function ownActorsOf(...actorIds: string[]): OwnActors {
  return new Map(
    actorIds.map((actorId) => [actorId, { characterId: 'probe-one' }]),
  );
}

/** A port whose postMessage records each message with its transfer list. */
function transferPort() {
  const posted: { message: unknown; transfer: unknown[] | undefined }[] = [];
  return {
    posted,
    reply: (message: DrawReply | NoDrawReport, transfer: unknown[]) => {
      posted.push({ message, transfer });
    },
  };
}

describe('I/O matrix', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transfer: a draw goes out with its ImageBitmaps as its transfer list, each once however many commands name it', () => {
    stubImageBitmap();
    const one = new FakeImageBitmap();
    const two = new FakeImageBitmap();
    const handlers = {
      frame: () => ({
        a1: [bitmapCommand(one), bitmapCommand(one)],
        a2: [bitmapCommand(two)],
      }),
    };
    const port = transferPort();

    routeStageMessage(
      frame(0, ['a1', 'a2']),
      handlers,
      ownActorsOf('a1', 'a2'),
      port.reply,
      bitmapBrandOf(globalThis),
    );

    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]?.message).toMatchObject({ type: 'draw', seq: 0 });
    // By identity: FakeImageBitmaps of one size are alike to toStrictEqual.
    const transfer = port.posted[0]?.transfer;
    expect(transfer).toHaveLength(2);
    expect(transfer).toContain(one);
    expect(transfer).toContain(two);
  });

  it('transfer: a draw without bitmaps has an empty transfer list; so has a no-draw', () => {
    const port = transferPort();

    routeStageMessage(
      frame(0, ['a1']),
      { frame: () => ({ a1: [] }) },
      new Map(),
      port.reply,
    );
    routeStageMessage(frame(1, ['a1']), {}, new Map(), port.reply);

    expect(port.posted.map((each) => each.transfer)).toStrictEqual([[], []]);
  });

  it(`位元組: an ImageBitmap counts as {} (2 bytes) for the ${DRAW_MAX_BYTES}-byte limit, so a draw with one is posted`, () => {
    stubImageBitmap();
    const image = new FakeImageBitmap(512, 512);
    const port = transferPort();
    // With the bitmap's 2 bytes, exactly at the limit.
    const command = bitmapCommand(image);
    const base = JSON.stringify({
      type: 'draw',
      seq: 0,
      actors: { a1: [{ ...command, image: {} }] },
    }).length;
    // `,"pad":""` is 9 more.
    const padded = { ...command, pad: 'x'.repeat(DRAW_MAX_BYTES - base - 9) };
    const exact = JSON.stringify({
      type: 'draw',
      seq: 0,
      actors: { a1: [{ ...padded, image: {} }] },
    }).length;
    expect(exact).toBe(DRAW_MAX_BYTES);

    routeStageMessage(
      frame(0, ['a1']),
      { frame: () => ({ a1: [padded] }) },
      ownActorsOf('a1'),
      port.reply,
      bitmapBrandOf(globalThis),
    );
    routeStageMessage(
      frame(1, ['a1']),
      {
        frame: () => ({ a1: [{ ...padded, pad: `${padded.pad as string}x` }] }),
      },
      ownActorsOf('a1'),
      port.reply,
      bitmapBrandOf(globalThis),
    );

    expect(port.posted.map((each) => each.message)).toStrictEqual([
      expect.objectContaining({ type: 'draw', seq: 0 }),
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-too-large' },
    ]);
    // By identity: FakeImageBitmaps keep their size private.
    expect(port.posted[0]?.transfer).toHaveLength(1);
    expect(port.posted[0]?.transfer?.[0]).toBe(image);
  });

  it('重複送: a draw whose bitmap cannot be transferred (sent before: the port throws) is answered with sandbox.no-draw (draw-not-cloneable); the next frame goes as usual', () => {
    stubImageBitmap();
    const sent = new Set<unknown>();
    const posted: unknown[] = [];
    // As a real port: a bitmap transferred once is detached.
    const reply = (message: DrawReply | NoDrawReport, transfer: unknown[]) => {
      if (transfer.some((each) => sent.has(each))) {
        throw new DOMException('An ImageBitmap is detached', 'DataCloneError');
      }
      for (const each of transfer) {
        sent.add(each);
      }
      posted.push(message);
    };
    const first = new FakeImageBitmap();
    const fresh = new FakeImageBitmap();
    const answers = [first, first, fresh];
    const handlers = {
      frame: (message: { seq: number }) => ({
        a1: [bitmapCommand(answers[message.seq] as object)],
      }),
    };

    const ownActors = ownActorsOf('a1');
    for (const seq of [0, 1, 2]) {
      routeStageMessage(
        frame(seq, ['a1']),
        handlers,
        ownActors,
        reply,
        bitmapBrandOf(globalThis),
      );
    }

    expect(posted).toStrictEqual([
      expect.objectContaining({ type: 'draw', seq: 0 }),
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-not-cloneable' },
      expect.objectContaining({ type: 'draw', seq: 2 }),
    ]);
  });

  it('一則藏很多張: a draw holding more different ImageBitmaps than the pack has own actors (hidden in another field) is not posted: sandbox.no-draw (draw-too-many-commands), nothing transferred; as many as its own actors is posted; the next frame goes as usual', () => {
    stubImageBitmap();
    const port = transferPort();
    const one = new FakeImageBitmap();
    const two = new FakeImageBitmap();
    const three = new FakeImageBitmap();
    const answers: Record<number, unknown> = {
      // Two images for two own actors, one of them named twice: posted.
      0: {
        a1: [bitmapCommand(one)],
        a2: [{ ...bitmapCommand(two), again: one }],
      },
      // One image more, in a field the overlay never reads.
      1: { a1: [{ ...bitmapCommand(one), spare: [two, three] }] },
      2: { a1: [bitmapCommand(three)] },
    };
    const handlers = {
      frame: (message: { seq: number }) => answers[message.seq],
    };
    const ownActors = ownActorsOf('a1', 'a2');

    for (const seq of [0, 1, 2]) {
      routeStageMessage(
        frame(seq, ['a1', 'a2']),
        handlers,
        ownActors,
        port.reply,
        bitmapBrandOf(globalThis),
      );
    }

    expect(port.posted.map((each) => each.message)).toStrictEqual([
      expect.objectContaining({ type: 'draw', seq: 0 }),
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-too-many-commands' },
      expect.objectContaining({ type: 'draw', seq: 2 }),
    ]);
    const [first, refused, next] = port.posted.map((each) => each.transfer);
    // By identity: FakeImageBitmaps of one size are alike to toStrictEqual.
    expect(first).toHaveLength(2);
    expect(first).toContain(one);
    expect(first).toContain(two);
    expect(refused).toStrictEqual([]);
    expect(next).toHaveLength(1);
    expect(next).toContain(three);
  });

  it('非純資料的 draw: images in a Map are not sent at all, not even as many as the pack has own actors, nor counted: the copy cannot take a Map (sandbox.no-draw, draw-not-cloneable), nothing transferred; a getter that throws while the draw is copied answers draw-not-cloneable too', () => {
    stubImageBitmap();
    const port = transferPort();
    const one = new FakeImageBitmap();
    const two = new FakeImageBitmap();
    const three = new FakeImageBitmap();
    const four = new FakeImageBitmap();
    const answers: Record<number, unknown> = {
      0: {
        a1: [
          {
            ...bitmapCommand(one),
            spare: new Map([
              ['x', two],
              ['y', three],
            ]),
          },
        ],
      },
      1: { a1: [{ ...bitmapCommand(four), spare: new Map([['x', two]]) }] },
      2: {
        a1: [
          {
            get boom() {
              throw new Error('no');
            },
          },
        ],
      },
      3: { a1: [bitmapCommand(four)] },
    };
    const handlers = {
      frame: (message: { seq: number }) => answers[message.seq],
    };
    const ownActors = ownActorsOf('a1', 'a2');

    for (const seq of [0, 1, 2, 3]) {
      routeStageMessage(
        frame(seq, ['a1', 'a2']),
        handlers,
        ownActors,
        port.reply,
        bitmapBrandOf(globalThis),
      );
    }

    expect(port.posted.map((each) => each.message)).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 0, reason: 'draw-not-cloneable' },
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-not-cloneable' },
      { type: 'sandbox.no-draw', seq: 2, reason: 'draw-not-cloneable' },
      expect.objectContaining({ type: 'draw', seq: 3 }),
    ]);
    const transfers = port.posted.map((each) => each.transfer);
    expect(transfers.slice(0, 3)).toStrictEqual([[], [], []]);
    // By identity: FakeImageBitmaps keep their size private.
    expect(transfers[3]).toHaveLength(1);
    expect(transfers[3]).toContain(four);
  });

  /** What `port` posted: its messages, and its transfer lists. */
  function postedOf(port: ReturnType<typeof transferPort>) {
    return {
      messages: port.posted.map((each) => each.message),
      transfers: port.posted.map((each) => each.transfer ?? []),
    };
  }

  /** Routes frames `seqs` to `handlers` with the stubbed brand check. */
  function routeFrames(
    handlers: object,
    seqs: readonly number[],
    port: ReturnType<typeof transferPort>,
  ): void {
    const ownActors = ownActorsOf('a1', 'a2');
    for (const seq of seqs) {
      routeStageMessage(
        frame(seq, ['a1', 'a2']),
        handlers,
        ownActors,
        port.reply,
        bitmapBrandOf(globalThis),
      );
    }
  }

  it("藏圖的寫法: an image whose prototype the pack changed (to Object.prototype, to null), with the width getter on ImageBitmap's prototype and instanceof forged after the brand check was kept, is still an image: the copy holds it itself and it is transferred, each once; a look-alike on that prototype is not one (draw-not-cloneable, nothing transferred)", () => {
    stubImageBitmap();
    const isBitmap = bitmapBrandOf(globalThis);
    const plain = Object.setPrototypeOf(
      new FakeImageBitmap(),
      Object.prototype,
    ) as object;
    const bare = Object.setPrototypeOf(new FakeImageBitmap(), null) as object;
    const width = Object.getOwnPropertyDescriptor(
      FakeImageBitmap.prototype,
      'width',
    ) as PropertyDescriptor;
    const port = transferPort();
    try {
      Object.defineProperty(FakeImageBitmap.prototype, 'width', {
        get: () => 8,
        configurable: true,
      });
      Object.defineProperty(FakeImageBitmap, Symbol.hasInstance, {
        value: () => false,
        configurable: true,
      });
      const lookAlike = Object.create(FakeImageBitmap.prototype) as object;
      const answers: Record<number, unknown> = {
        0: { a1: [bitmapCommand(plain)], a2: [bitmapCommand(bare)] },
        1: { a1: [bitmapCommand(lookAlike)] },
      };
      const ownActors = ownActorsOf('a1', 'a2');
      for (const seq of [0, 1]) {
        routeStageMessage(
          frame(seq, ['a1', 'a2']),
          { frame: (message: { seq: number }) => answers[message.seq] },
          ownActors,
          port.reply,
          isBitmap,
        );
      }
    } finally {
      Object.defineProperty(FakeImageBitmap.prototype, 'width', width);
      Reflect.deleteProperty(FakeImageBitmap, Symbol.hasInstance);
    }

    const { messages, transfers } = postedOf(port);
    expect(messages).toStrictEqual([
      expect.objectContaining({ type: 'draw', seq: 0 }),
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-not-cloneable' },
    ]);
    const actors = (messages[0] as DrawReply).actors as Record<
      string,
      { image?: unknown }[]
    >;
    expect(actors.a1?.[0]?.image).toBe(plain);
    expect(actors.a2?.[0]?.image).toBe(bare);
    expect(transfers[0]).toHaveLength(2);
    expect(transfers[0]).toContain(plain);
    expect(transfers[0]).toContain(bare);
    expect(transfers[1]).toStrictEqual([]);
  });

  it("藏圖的寫法: an image whose prototype the pack changed to another object's (Date.prototype), and one on ImageBitmap's prototype whose instanceof the pack forged, with as many own actors as images, go out as a draw, both transferred: the copy is measured by the brand check copyPlain used, not by instanceof", () => {
    stubImageBitmap();
    const isBitmap = bitmapBrandOf(globalThis);
    const dated = Object.setPrototypeOf(
      new FakeImageBitmap(),
      Date.prototype,
    ) as object;
    const forged = new FakeImageBitmap();
    const port = transferPort();
    try {
      Object.defineProperty(FakeImageBitmap, Symbol.hasInstance, {
        value: () => false,
        configurable: true,
      });
      routeStageMessage(
        frame(0, ['a1', 'a2']),
        {
          frame: () => ({
            a1: [bitmapCommand(dated)],
            a2: [bitmapCommand(forged)],
          }),
        },
        ownActorsOf('a1', 'a2'),
        port.reply,
        isBitmap,
      );
    } finally {
      Reflect.deleteProperty(FakeImageBitmap, Symbol.hasInstance);
    }

    const { messages, transfers } = postedOf(port);
    expect(messages).toStrictEqual([
      expect.objectContaining({ type: 'draw', seq: 0 }),
    ]);
    const actors = (messages[0] as DrawReply).actors as Record<
      string,
      { image?: unknown }[]
    >;
    expect(actors.a1?.[0]?.image).toBe(dated);
    expect(actors.a2?.[0]?.image).toBe(forged);
    expect(transfers[0]).toHaveLength(2);
    expect(transfers[0]).toContain(dated);
    expect(transfers[0]).toContain(forged);
  });

  it("藏圖的寫法: an image on a list's own property that is not an index (on the actor's command list, on a list in a command, under a symbol) is not sent, though the pack has as many own actors as images: the copy takes no such list (sandbox.no-draw, draw-not-cloneable), nothing transferred; the next frame goes as usual", () => {
    stubImageBitmap();
    const one = new FakeImageBitmap();
    const two = new FakeImageBitmap();
    const symbolic: unknown[] = [bitmapCommand(one)];
    Object.defineProperty(symbolic, Symbol('spare'), {
      value: two,
      enumerable: true,
    });
    const answers: Record<number, unknown> = {
      0: { a1: Object.assign([bitmapCommand(one)], { spare: two }) },
      1: {
        a1: [
          {
            ...bitmapCommand(one),
            list: Object.assign([1, 2], { spare: two }),
          },
        ],
      },
      2: { a1: symbolic },
      3: { a1: [bitmapCommand(one)] },
    };
    const port = transferPort();

    routeFrames(
      { frame: (message: { seq: number }) => answers[message.seq] },
      [0, 1, 2, 3],
      port,
    );

    const { messages, transfers } = postedOf(port);
    expect(messages).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 0, reason: 'draw-not-cloneable' },
      { type: 'sandbox.no-draw', seq: 1, reason: 'draw-not-cloneable' },
      { type: 'sandbox.no-draw', seq: 2, reason: 'draw-not-cloneable' },
      expect.objectContaining({ type: 'draw', seq: 3 }),
    ]);
    expect(transfers.slice(0, 3)).toStrictEqual([[], [], []]);
    expect(transfers[3]).toHaveLength(1);
    expect(transfers[3]).toContain(one);
    expect(transfers.flat()).not.toContain(two);
  });

  it('藏圖的寫法: a getter that gives another image each time it is read is read once: the copy holds the first image as a plain value and only it is transferred; the second is never read, so it goes nowhere', () => {
    stubImageBitmap();
    const first = new FakeImageBitmap();
    const second = new FakeImageBitmap();
    let reads = 0;
    const command = {
      type: 'bitmap',
      x: -32,
      y: -96,
      width: 64,
      height: 64,
      get image() {
        reads += 1;
        return reads === 1 ? first : second;
      },
    };
    const port = transferPort();

    routeFrames({ frame: () => ({ a1: [command] }) }, [0], port);

    expect(reads).toBe(1);
    const { messages, transfers } = postedOf(port);
    expect(messages).toStrictEqual([
      expect.objectContaining({ type: 'draw', seq: 0 }),
    ]);
    const copy = ((messages[0] as DrawReply).actors as Record<string, object[]>)
      .a1?.[0] as object;
    expect(copy).not.toBe(command);
    expect(Object.getOwnPropertyDescriptor(copy, 'image')?.value).toBe(first);
    const found = imageBitmapsIn(messages[0]);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(first);
    expect(transfers[0]).toHaveLength(1);
    expect(transfers[0]).toContain(first);
    expect(transfers[0]).not.toContain(second);
  });

  it('藏圖的寫法: an image in a Map whose own way of going through it was rewritten (Symbol.iterator, entries, forEach, size) is not sent: the copy takes no Map (sandbox.no-draw, draw-not-cloneable), nothing transferred; the next frame goes as usual', () => {
    stubImageBitmap();
    const one = new FakeImageBitmap();
    const two = new FakeImageBitmap();
    const sneaky = new Map<string, unknown>([['x', two]]);
    const nothing = () => [][Symbol.iterator]();
    Object.defineProperties(sneaky, {
      [Symbol.iterator]: { value: nothing },
      entries: { value: nothing },
      keys: { value: nothing },
      values: { value: nothing },
      forEach: { value: () => {} },
      size: { get: () => 0 },
    });
    const answers: Record<number, unknown> = {
      0: { a1: [{ ...bitmapCommand(one), spare: sneaky }] },
      1: { a1: [bitmapCommand(one)] },
    };
    const port = transferPort();

    routeFrames(
      { frame: (message: { seq: number }) => answers[message.seq] },
      [0, 1],
      port,
    );

    const { messages, transfers } = postedOf(port);
    expect(messages).toStrictEqual([
      { type: 'sandbox.no-draw', seq: 0, reason: 'draw-not-cloneable' },
      expect.objectContaining({ type: 'draw', seq: 1 }),
    ]);
    expect(transfers[0]).toStrictEqual([]);
    expect(transfers[1]).toHaveLength(1);
    expect(transfers[1]).toContain(one);
    expect(transfers.flat()).not.toContain(two);
  });

  it.each<[string, () => unknown]>([
    ['undefined (a frame that returns nothing)', () => undefined],
    [
      'an undefined in a command',
      () => ({ a1: [{ type: 'sprite', asset: 'x', x: 0, y: undefined }] }),
    ],
    ['a Map', () => ({ a1: new Map() })],
    ['a Set', () => ({ a1: [new Set()] })],
    ['a function', () => ({ a1: [() => 1] })],
    ['a symbol', () => ({ a1: [Symbol('s')] })],
    ['a bigint', () => ({ a1: [1n] })],
    ['NaN', () => ({ a1: [{ type: 'sprite', asset: 'x', x: NaN, y: 0 }] })],
    ['an infinity', () => ({ a1: [Infinity] })],
    ['a Date', () => ({ a1: [new Date(0)] })],
    ['a typed array', () => ({ a1: [new Uint8Array(4)] })],
    ['an object of a class', () => ({ a1: [new (class Thing {})()] })],
    [
      'an object of another prototype',
      () => ({ a1: [Object.create({ inherited: 1 }) as object] }),
    ],
    [
      // Within DRAW_MAX_BYTES, yet structured clone would throw a RangeError.
      'a list nested 30000 deep',
      () => ({ a1: nestedLists(30_000) }),
    ],
    [
      'a list with a hole',
      () => {
        const list: unknown[] = [1];
        list[2] = 3;
        return { a1: list };
      },
    ],
    [
      'a Proxy whose trap throws',
      () => ({
        a1: new Proxy([], {
          ownKeys() {
            throw new Error('no');
          },
        }),
      }),
    ],
  ])(
    '非純資料的 draw: %s is not sent: sandbox.no-draw (draw-not-cloneable); the next frame goes as usual',
    (_label, make) => {
      const port = transferPort();
      const handlers = {
        frame: (message: { seq: number }) =>
          message.seq === 0 ? make() : { a1: [] },
      };

      routeFrames(handlers, [0, 1], port);

      expect(postedOf(port)).toStrictEqual({
        messages: [
          { type: 'sandbox.no-draw', seq: 0, reason: 'draw-not-cloneable' },
          { type: 'draw', seq: 1, actors: { a1: [] } },
        ],
        transfers: [[], []],
      });
    },
  );

  it('snapshot 次數: a second stage.snapshot for one actor before the next frame throws a TypeError and takes nothing; the next frame it may again; each actor counts apart; a fresh init lets it again', () => {
    stubImageBitmap();
    const fake = fakeOffscreenCanvas();
    const ownActors: OwnActors = new Map();
    const stage = createStage(
      (value) => value,
      () => {},
      ownActors,
      {
        characters: new Set(['probe-one', 'probe-two']),
        makeCanvas: (width, height) => {
          const canvas = new fake.OffscreenCanvas(width, height);
          return { canvas, context: canvas.getContext('2d') as object };
        },
      },
    ) as {
      canvas(actorId: string, width: number, height: number): object;
      snapshot(actorId: string): unknown;
    };
    /** Calls stage.snapshot for each of `actorIds` in turn: what each did. */
    const snapshots = (actorIds: readonly string[]): string[] =>
      actorIds.map((actorId) => {
        try {
          stage.snapshot(actorId);
          return 'bitmap';
        } catch (error) {
          return error instanceof TypeError ? 'TypeError' : 'other';
        }
      });
    const inFrames: string[][] = [];
    const handlers = {
      frame: () => {
        inFrames.push(snapshots(['a1', 'a1', 'a2', 'a1']));
        return {};
      },
    };
    route(handlers, [INIT, SPAWN], ownActors);
    stage.canvas('a1', 8, 8);
    stage.canvas('a2', 8, 8);

    route(
      handlers,
      [frame(0, ['a1', 'a2']), frame(1, ['a1', 'a2'])],
      ownActors,
    );

    const once = ['bitmap', 'TypeError', 'bitmap', 'TypeError'];
    expect(inFrames).toStrictEqual([once, once]);
    // One bitmap a frame from each canvas: the refused calls took none.
    expect(fake.made.map((canvas) => canvas.bitmaps.length)).toStrictEqual([
      2, 2,
    ]);
    // Out of the handler, before the next frame: still that frame's.
    expect(snapshots(['a1'])).toStrictEqual(['TypeError']);

    // A fresh init: new own actors, none snapshot yet.
    route(handlers, [INIT], ownActors);
    stage.canvas('a1', 8, 8);
    expect(snapshots(['a1', 'a1'])).toStrictEqual(['bitmap', 'TypeError']);
  });

  it('釋放: an own actor that leaves (despawn) takes its canvas with it, shrunk to nothing; so does an init', () => {
    const fake = fakeOffscreenCanvas();
    const ownActors: OwnActors = new Map();
    const stage = createStage(
      (value) => value,
      () => {},
      ownActors,
      {
        characters: new Set(['probe-one', 'probe-two']),
        makeCanvas: (width, height) => {
          const canvas = new fake.OffscreenCanvas(width, height);
          return { canvas, context: canvas.getContext('2d') as object };
        },
      },
    ) as {
      canvas(actorId: string, width: number, height: number): object;
      snapshot(actorId: string): unknown;
    };
    route({}, [INIT, SPAWN], ownActors);
    stage.canvas('a1', 32, 32);
    stage.canvas('a2', 16, 16);

    route({}, [{ type: 'despawn', actorId: 'a2' }], ownActors);

    expect(ownActors.has('a2')).toBe(false);
    expect([fake.made[1]?.width, fake.made[1]?.height]).toStrictEqual([0, 0]);
    expect(() => stage.canvas('a2', 16, 16)).toThrow(TypeError);
    expect([fake.made[0]?.width, fake.made[0]?.height]).toStrictEqual([32, 32]);

    route({}, [INIT], ownActors);
    expect([fake.made[0]?.width, fake.made[0]?.height]).toStrictEqual([0, 0]);
    expect(ownActors.get('a1')).toStrictEqual({ characterId: 'probe-one' });
    expect(() => stage.snapshot('a1')).toThrow(TypeError);
  });
});

describe('bitmapCharactersOf', () => {
  it('takes exactly { type: "sandbox.bitmap-characters", characterIds: [strings] }, as pack-host makes it', () => {
    expect(
      bitmapCharactersOf(sandboxBitmapCharactersMessage(['probe-one'])),
    ).toStrictEqual(['probe-one']);
    expect(
      bitmapCharactersOf({
        type: 'sandbox.bitmap-characters',
        characterIds: [],
      }),
    ).toStrictEqual([]);
    for (const data of [
      null,
      'sandbox.bitmap-characters',
      { type: 'sandbox.bitmap-characters' },
      { type: 'sandbox.bitmap-characters', characterIds: 'probe-one' },
      { type: 'sandbox.bitmap-characters', characterIds: [1] },
      { type: 'sandbox.bitmaps', characterIds: ['probe-one'] },
      {
        type: 'sandbox.bitmap-characters',
        characterIds: ['probe-one'],
        more: 1,
      },
    ]) {
      expect(bitmapCharactersOf(data), JSON.stringify(data)).toBeUndefined();
    }
  });
});

describe('I/O matrix', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A port that records each message with its transfer list. */
  function recordingPort() {
    const port = fakePort();
    const transfers: unknown[][] = [];
    const postMessage = port.port.postMessage;
    port.port.postMessage = (message: unknown, transfer?: unknown[]) => {
      transfers.push(transfer ?? []);
      postMessage(message);
    };
    return { ...port, transfers };
  }

  it("沒宣告的角色: pack-host's own message (sandbox.*) on the port never reaches the pack; the bitmap characters it names are the ones stage.canvas answers for", () => {
    stubImageBitmap();
    const fake = fakeOffscreenCanvas();
    const seen: string[] = [];
    const outcomes: string[] = [];
    const worker = lockedScope({});
    worker.scope.OffscreenCanvas = fake.OffscreenCanvas;
    // The Worker's own ImageBitmap, whose brand check boot() keeps.
    worker.scope.ImageBitmap = FakeImageBitmap;
    // The factory's stage, as handlers that try the canvas of each actor.
    (worker.scope as { lockdown: () => void }).lockdown = () => {
      worker.scope.harden = <T>(value: T): T => value;
      worker.scope.Compartment = class {
        evaluate() {
          return (stage: {
            canvas(id: string, w: number, h: number): object;
            snapshot(id: string): unknown;
          }) => {
            const tryCanvas = (actorId: string) => {
              try {
                stage.canvas(actorId, 8, 8);
                return 'made';
              } catch (error) {
                return (error as Error).name;
              }
            };
            const all = (type: string) => (message: unknown) => {
              seen.push(type);
              return message;
            };
            return {
              init: all('init'),
              spawn: all('spawn'),
              frame: () => {
                seen.push('frame');
                outcomes.push(`a1 ${tryCanvas('a1')}`, `a2 ${tryCanvas('a2')}`);
                return { a1: [bitmapCommand(stage.snapshot('a1') as object)] };
              },
              // Any message, reached here, would be seen.
              ['sandbox.bitmap-characters']: all('internal'),
            };
          };
        }
      };
    };
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const port = recordingPort();
    worker.emit('message', { data: { type: 'port' }, ports: [port.port] });

    port.send(sandboxBitmapCharactersMessage(['probe-one']));
    // Not exactly one: ignored (taken, probe-two would replace probe-one).
    port.send({ ...sandboxBitmapCharactersMessage(['probe-two']), more: 1 });
    port.send({ type: 'sandbox.other', characterIds: ['probe-two'] });
    port.send(INIT);
    port.send(SPAWN);
    port.send(frame(0, ['a1', 'a2']));

    expect(seen).toStrictEqual(['init', 'spawn', 'frame']);
    expect(outcomes).toStrictEqual(['a1 made', 'a2 TypeError']);
    // The draw goes back with the snapshot as its transfer list.
    const bitmap = fake.made[1]?.bitmaps[0];
    expect(bitmap).toBeDefined();
    // By identity: FakeImageBitmaps keep their size private.
    expect(port.transfers.at(-1)).toHaveLength(1);
    expect(port.transfers.at(-1)?.[0]).toBe(bitmap);
    expect(port.sent.at(-1)).toMatchObject({ type: 'draw', seq: 0 });
  });

  it('沒宣告的角色: without that message no character has a canvas', () => {
    const fake = fakeOffscreenCanvas();
    let outcome = '';
    const worker = lockedScope({});
    worker.scope.OffscreenCanvas = fake.OffscreenCanvas;
    (worker.scope as { lockdown: () => void }).lockdown = () => {
      worker.scope.harden = <T>(value: T): T => value;
      worker.scope.Compartment = class {
        evaluate() {
          return (stage: {
            canvas(id: string, w: number, h: number): object;
          }) => ({
            frame: () => {
              try {
                stage.canvas('a1', 8, 8);
                outcome = 'made';
              } catch (error) {
                outcome = (error as Error).name;
              }
              return {};
            },
          });
        }
      };
    };
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const port = fakePort();
    worker.emit('message', { data: { type: 'port' }, ports: [port.port] });

    port.send(INIT);
    port.send(frame(0, ['a1']));

    expect(outcome).toBe('TypeError');
  });
});

// RP-19: what the Worker measures must be what it sends. copyPlain reads
// the pack's value once into fresh plain data; structured clone (the real
// port) of that copy gives the copy back, nothing more.
describe('copyPlain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, () => unknown]>([
    ['null', () => null],
    ['booleans', () => [true, false]],
    ['finite numbers', () => [0, -1.5, 1e21, Number.MAX_SAFE_INTEGER]],
    ['strings', () => ['', 'é😀', 'x'.repeat(100)]],
    ['empty list and object', () => [[], {}]],
    [
      'nested data',
      () => ({ a1: [{ type: 'sprite', x: 1, y: [null, { z: 'w' }] }] }),
    ],
    [
      'an object without prototype',
      () => Object.assign(Object.create(null) as object, { a: 1, b: [2] }),
    ],
  ])(
    'copies %s into fresh plain data, equal to what structured clone sends of it',
    (_label, make) => {
      const value = make();

      const copied = copyPlain(value, 10_000, NO_BITMAP_BRAND, false);

      expect(copied.kind).toBe('copied');
      if (copied.kind !== 'copied') {
        return;
      }
      expect(copied.value).toStrictEqual(structuredClone(value));
      expect(structuredClone(copied.value)).toStrictEqual(copied.value);
      expect(copied.bitmaps).toStrictEqual([]);
      if (typeof value === 'object' && value !== null) {
        expect(copied.value).not.toBe(value);
      }
    },
  );

  it('keeps a key named __proto__ a key of the copy (its prototype stays Object.prototype)', () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1},"y":2}');

    const copied = copyPlain(value, 1000, NO_BITMAP_BRAND, false);

    expect(copied.kind).toBe('copied');
    const copy = (copied as { value: object }).value;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toStrictEqual(['__proto__', 'y']);
    expect(
      Object.getOwnPropertyDescriptor(copy, '__proto__')?.value,
    ).toStrictEqual({ x: 1 });
  });

  it('reads each part once: a getter runs once, and a Proxy of a list has each index read once', () => {
    let getterReads = 0;
    const reads = new Map<PropertyKey, number>();
    const list = new Proxy([1, { b: 2 }], {
      get(target, key, receiver) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const value = {
      get a() {
        getterReads += 1;
        return getterReads;
      },
      list,
    };

    const copied = copyPlain(value, 1000, NO_BITMAP_BRAND, false);

    expect(copied).toStrictEqual({
      kind: 'copied',
      value: { a: 1, list: [1, { b: 2 }] },
      bitmaps: [],
    });
    expect(getterReads).toBe(1);
    expect(reads.get('0')).toBe(1);
    expect(reads.get('1')).toBe(1);
  });

  it('stops as too-large once over the limit, before reading further: a cycle, a fan-out graph, a list longer than the limit (none of its elements read), a long string', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let fan: object = {};
    for (let i = 0; i < 64; i += 1) {
      fan = { a: fan, b: fan };
    }
    let elementReads = 0;
    // Holes only: nothing allocated for its length.
    const holes: unknown[] = [];
    holes.length = 10_000_000;
    const long = new Proxy(holes, {
      get(target, key, receiver) {
        if (key !== 'length') {
          elementReads += 1;
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    for (const value of [cycle, fan, long, 'x'.repeat(2000)]) {
      expect(copyPlain(value, 1000, NO_BITMAP_BRAND, false)).toStrictEqual({
        kind: 'too-large',
      });
    }
    expect(elementReads).toBe(0);
  });

  it(`copies a value nested ${COPY_MAX_DEPTH} (COPY_MAX_DEPTH) lists and objects deep, itself the first; one deeper cannot be copied`, () => {
    const deepest = nestedLists(COPY_MAX_DEPTH);

    expect(copyPlain(deepest, 10_000, NO_BITMAP_BRAND, false)).toMatchObject({
      kind: 'copied',
    });
    for (const deeper of [[deepest], { a: deepest }]) {
      expect(copyPlain(deeper, 10_000, NO_BITMAP_BRAND, false)).toStrictEqual({
        kind: 'not-plain',
      });
    }
  });

  it('counts no more than jsonBytes does for the copy: at exactly jsonBytes it copies; one less is too-large for ASCII data (where the two agree)', () => {
    const ascii = { a1: [{ type: 'sprite', asset: 'x', x: -1.5, y: 0 }, null] };
    const wide = { text: 'é😀漢' };

    const bytes = jsonBytes(ascii, 10_000) as number;
    expect(copyPlain(ascii, bytes, NO_BITMAP_BRAND, false).kind).toBe('copied');
    expect(copyPlain(ascii, bytes - 1, NO_BITMAP_BRAND, false).kind).toBe(
      'too-large',
    );
    const wideBytes = jsonBytes(wide, 10_000) as number;
    expect(copyPlain(wide, wideBytes, NO_BITMAP_BRAND, false).kind).toBe(
      'copied',
    );
  });

  it('an ImageBitmap (as the brand check tells) goes into the copy itself and into bitmaps, each once however often it is met; without keepBitmaps it cannot be copied', () => {
    stubImageBitmap();
    const isBitmap = bitmapBrandOf(globalThis);
    const image = new FakeImageBitmap();
    const value = { a1: [{ image }, { image, again: [image] }] };

    const copied = copyPlain(value, 1000, isBitmap, true);

    expect(copied.kind).toBe('copied');
    if (copied.kind !== 'copied') {
      return;
    }
    const copy = copied.value as {
      a1: [{ image: unknown }, { again: unknown[] }];
    };
    expect(copy.a1[0].image).toBe(image);
    expect(copy.a1[1].again[0]).toBe(image);
    expect(copied.bitmaps).toHaveLength(1);
    expect(copied.bitmaps[0]).toBe(image);
    expect(copyPlain(value, 1000, isBitmap, false)).toStrictEqual({
      kind: 'not-plain',
    });
    // Unknown to the brand check (none given): an object of a class.
    expect(copyPlain(value, 1000, NO_BITMAP_BRAND, true)).toStrictEqual({
      kind: 'not-plain',
    });
  });
});
