/**
 * The Worker bootstrap's side of the stage messages (Story 3.6): each
 * message checked against stageMessageSchema and handed to the pack's
 * handler, the pack's own actors kept for `stage.random`, `frame`'s answer
 * wrapped as `draw` (or `sandbox.no-draw`), and run() listening on the port
 * once it comes. With fake handlers and ports; the contract test pack's
 * entry is evaluated here without SES (the real boot is in build.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  countConsole,
  createStage,
  type DrawReply,
  type NoDrawReport,
  routeStageMessage,
  run,
} from '../../src/sandbox/worker-bootstrap';
import {
  drawMessageSchema,
  type StageMessage,
} from '../../src/shared/pack-api';
import { DRAW_MAX_BYTES, DRAW_MAX_COMMANDS } from '../../src/shared/constants';
import { sandboxReportSchema } from '../../src/shared/sandbox';

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
  ownActors = new Set<string>(),
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
function contractHandlers(ownActors: Set<string>): object {
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
    expect([...ownActors]).toStrictEqual([]);
  });

  it("keeps the pack's own actors: init and spawn before the handler runs, despawn after", () => {
    const seen: string[][] = [];
    const ownActors = new Set<string>(['stale']);
    const handlers = {
      init() {
        seen.push(['init', ...ownActors]);
      },
      spawn() {
        seen.push(['spawn', ...ownActors]);
      },
      despawn() {
        seen.push(['despawn', ...ownActors]);
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
    expect([...ownActors]).toStrictEqual(['a2']);
  });

  it('stage.random answers for the own actors the messages named, and for no other pack’s', () => {
    const ownActors = new Set<string>();
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
      routeStageMessage(frame(seq, ['a1']), handlers, new Set(), reply);
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
        new Set(),
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

    expect([...ownActors]).toStrictEqual(['a1']);
    expect(replies).toStrictEqual([{ type: 'draw', seq: 0, actors: {} }]);
  });
});

describe('I/O matrix', () => {
  it("出現: the contract test pack answers init, spawn and frames with draws that pass drawMessageSchema, one per frame, each actor's look", () => {
    const ownActors = new Set<string>();
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
