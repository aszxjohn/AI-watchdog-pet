/**
 * The overlay's pack-host (Story 3.5): the sandboxes' lifecycle from
 * StageView's actors and packs, the checks on what a sandbox sends, and the
 * run log lines, with fake iframes, a fake main and fake timers; and the
 * real iframe factory (dom.ts) over a fake document with Node's
 * MessageChannel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDomSandboxFrames,
  type SandboxFrameChannel,
  type SandboxIframeElement,
} from '../../src/overlay/pack-host/dom';
import {
  createPackHost,
  type PackHost,
  type PackHostApi,
  type SandboxFrameHandlers,
  type SandboxFrames,
} from '../../src/overlay/pack-host/host';
import {
  actorsByPack,
  checkPackMessage,
  createRateLimiter,
  jsonBytes,
  packIdOf,
} from '../../src/overlay/pack-host/rules';
import {
  PACK_DROP_LOG_INTERVAL_MS,
  SANDBOX_BOOT_TIMEOUT_MS,
  PACK_MESSAGE_MAX_BYTES,
  PACK_MESSAGE_RATE_LIMIT,
  PACK_MESSAGE_RATE_WINDOW_MS,
  SANDBOX_IDLE_MS,
  STAGE_LOG_MAX_LENGTH,
  STAGE_LOG_RATE_LIMIT,
  STAGE_LOG_RATE_WINDOW_MS,
} from '../../src/shared/constants';
import type { IpcResult } from '../../src/shared/ipc';
import type { PackEntryResult, StagePack } from '../../src/shared/packs';
import type { StageActor } from '../../src/shared/pool';
import {
  type PackLogEntry,
  packLogEntrySchema,
  SANDBOX_DOCUMENT_URL,
  type SandboxLoadMessage,
} from '../../src/shared/sandbox';
import type { StageView } from '../../src/shared/stage-view';
import { FakeImageBitmap, stubImageBitmap } from '../helpers/fake-bitmaps';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';

const ALPHA = 'alpha-pack';
const BRAVO = 'bravo-pack';

function stagePack(id: string, compatible = true): StagePack {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: compatible ? '1.0' : '1.9',
    characters: [{ id: 'probe-a', name: '甲', height: 110 }],
    compatibility: compatible
      ? { compatible: true }
      : { compatible: false, reason: 'pack-newer', required: '1.9' },
  };
}

function actor(actorId: string, packId: string): StageActor {
  return {
    actorId,
    sessionKey: `demo:${actorId}`,
    characterKey: `${packId}/probe-a`,
    state: 'working',
    confidence: 'exact',
    displayName: `session ${actorId}`,
  };
}

function view(
  actors: readonly StageActor[],
  installed: readonly StagePack[] = [stagePack(ALPHA), stagePack(BRAVO)],
): Pick<StageView, 'actors' | 'packs' | 'characters'> {
  return {
    actors: [...actors],
    packs: { installed: [...installed] },
    characters: {},
  };
}

const SOURCE = (packId: string) =>
  `(function (stage) { return {}; }); // ${packId}`;

const READY = {
  type: 'sandbox.ready',
  removals: [
    { name: 'fetch', status: 'removed' },
    { name: 'caches', status: 'absent' },
    { name: 'Iterator.prototype.join', status: 'removed' },
  ],
  consoleLines: 0,
} as const;

interface FakeFrame {
  readonly handlers: SandboxFrameHandlers;
  readonly handed: SandboxLoadMessage[];
  /** What pack-host posted on the port (Story 3.6). */
  readonly posted: unknown[];
  removed: boolean;
}

/** A fake main, fake iframes and a fake clock around one pack-host. */
function setup(
  options: {
    entry?: (
      packId: string,
    ) => IpcResult<PackEntryResult> | Promise<IpcResult<PackEntryResult>>;
  } = {},
) {
  const clock: FakeClock = fakeClock();
  const logs: PackLogEntry[] = [];
  const requests: unknown[][] = [];
  const order: string[] = [];
  const frames: FakeFrame[] = [];
  const calls: unknown[][] = [];
  const api: PackHostApi = {
    getEntry: vi.fn(async (...args: unknown[]) => {
      requests.push(args);
      order.push(`getEntry ${String(args[0])}`);
      const packId = String(args[0]);
      return (
        options.entry?.(packId) ?? {
          ok: true as const,
          data: {
            ok: true as const,
            packId,
            version: '1.0.0',
            source: SOURCE(packId),
          },
        }
      );
    }),
    log: vi.fn(async (entry: PackLogEntry) => {
      expect(packLogEntrySchema.safeParse(entry).success).toBe(true);
      logs.push(entry);
      return { ok: true as const, data: null };
    }),
  };
  const sandboxFrames: SandboxFrames = {
    create(handlers) {
      order.push('create');
      const frame: FakeFrame = {
        handlers,
        handed: [],
        posted: [],
        removed: false,
      };
      frames.push(frame);
      return {
        hand(message) {
          order.push('hand');
          frame.handed.push(message);
        },
        post(message) {
          frame.posted.push(message);
        },
        remove() {
          frame.removed = true;
        },
      };
    },
  };
  const host: PackHost = createPackHost({
    api,
    frames: sandboxFrames,
    clock: {
      now: clock.monotonic,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
    onCall: (packId, call) => {
      calls.push([packId, call]);
    },
    logError: () => {},
  });
  return { host, api, clock, logs, requests, order, frames, calls };
}

/** Lets main's answer (a resolved promise) reach pack-host. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** Shows `actors` and brings each new frame up to ready. */
async function showReady(
  t: ReturnType<typeof setup>,
  actors: readonly StageActor[],
): Promise<void> {
  const before = t.frames.length;
  t.host.onView(view(actors));
  await settle();
  for (const frame of t.frames.slice(before)) {
    frame.handlers.onLoad();
    frame.handlers.onMessage(READY);
  }
}

function kinds(logs: readonly PackLogEntry[]): string[] {
  return logs.map((entry) => `${entry.kind} ${entry.packId}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('I/O matrix', () => {
  it('第一個 actor: entry first, then the iframe; on load one hand-over of the source; ready logs one line with the pack id', async () => {
    const t = setup();

    t.host.onView(view([actor('a1', ALPHA)]));
    expect(t.order).toStrictEqual([`getEntry ${ALPHA}`]);
    await settle();
    expect(t.order).toStrictEqual([`getEntry ${ALPHA}`, 'create']);
    expect(t.frames[0]?.handed).toStrictEqual([]);

    t.frames[0]?.handlers.onLoad();
    t.frames[0]?.handlers.onLoad();
    expect(t.frames[0]?.handed).toStrictEqual([
      { type: 'load', source: SOURCE(ALPHA) },
    ]);

    t.frames[0]?.handlers.onMessage(READY);
    expect(t.logs).toStrictEqual([
      {
        kind: 'sandbox-ready',
        packId: ALPHA,
        version: '1.0.0',
        removals: READY.removals,
        consoleLines: 0,
      },
    ]);
    expect(t.host.phases()).toStrictEqual(new Map([[ALPHA, 'ready']]));
  });

  it('同包多 actor: another actor of the same pack builds no new sandbox', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);

    await showReady(t, [actor('a1', ALPHA), actor('a2', ALPHA)]);

    expect(t.requests).toStrictEqual([[ALPHA]]);
    expect(t.frames).toHaveLength(1);
  });

  it('不同包: two packs with actors get one iframe and one Worker each, each its own source', async () => {
    const t = setup();

    await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);

    expect(t.requests).toStrictEqual([[ALPHA], [BRAVO]]);
    expect(t.frames.map((frame) => frame.handed)).toStrictEqual([
      [{ type: 'load', source: SOURCE(ALPHA) }],
      [{ type: 'load', source: SOURCE(BRAVO) }],
    ]);
    expect(kinds(t.logs)).toStrictEqual([
      `sandbox-ready ${ALPHA}`,
      `sandbox-ready ${BRAVO}`,
    ]);
  });

  it(`最後一個離場: the iframe goes ${SANDBOX_IDLE_MS} ms after the last actor left, with one line`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('a2', ALPHA)]);
    t.logs.length = 0;

    t.host.onView(view([actor('a2', ALPHA)]));
    t.clock.advance(SANDBOX_IDLE_MS);
    expect(t.frames[0]?.removed).toBe(false);

    t.host.onView(view([]));
    t.clock.advance(SANDBOX_IDLE_MS - 1);
    expect(t.frames[0]?.removed).toBe(false);
    t.clock.advance(1);

    expect(t.frames[0]?.removed).toBe(true);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-destroyed', packId: ALPHA, reason: 'idle' },
    ]);
    expect(t.host.phases().size).toBe(0);
    expect(t.clock.pendingCount()).toBe(0);
  });

  it('最後一個離場: an actor coming back within the wait keeps the sandbox; one after it gets a new one', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);

    t.host.onView(view([]));
    t.clock.advance(SANDBOX_IDLE_MS - 1);
    t.host.onView(view([actor('a3', ALPHA)]));
    t.clock.advance(SANDBOX_IDLE_MS * 2);
    expect(t.frames[0]?.removed).toBe(false);
    expect(t.requests).toHaveLength(1);

    t.host.onView(view([]));
    t.clock.advance(SANDBOX_IDLE_MS);
    await showReady(t, [actor('a4', ALPHA)]);

    expect(t.frames).toHaveLength(2);
    expect(t.requests).toStrictEqual([[ALPHA], [ALPHA]]);
  });

  it('最後一個離場: a sandbox whose entry is still on its way when the wait ends is dropped; the late entry builds nothing', async () => {
    let answer: (result: IpcResult<PackEntryResult>) => void = () => {};
    const t = setup({
      entry: () =>
        new Promise<IpcResult<PackEntryResult>>((resolve) => {
          answer = resolve;
        }),
    });

    t.host.onView(view([actor('a1', ALPHA)]));
    t.host.onView(view([]));
    t.clock.advance(SANDBOX_IDLE_MS);
    answer({
      ok: true,
      data: { ok: true, packId: ALPHA, version: '1.0.0', source: 'x' },
    });
    await settle();

    expect(t.frames).toHaveLength(0);
    expect(t.logs).toStrictEqual([]);
  });

  it('找不到包: an actor of a pack that is not installed gets no sandbox and one line; the other pack goes on', async () => {
    const t = setup();
    const actors = [actor('x1', 'gone-pack'), actor('a1', ALPHA)];

    t.host.onView(view(actors));
    t.host.onView(view([...actors, actor('x2', 'gone-pack')]));
    await settle();

    expect(t.requests).toStrictEqual([[ALPHA]]);
    expect(t.frames).toHaveLength(1);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-skipped', packId: 'gone-pack', reason: 'not-installed' },
    ]);
  });

  it('找不到包: once installed while its actor is still there, the pack gets its sandbox', async () => {
    const t = setup();
    const actors = [actor('x1', 'late-pack')];

    t.host.onView(view(actors));
    t.host.onView(view(actors, [stagePack('late-pack')]));
    await settle();

    expect(t.requests).toStrictEqual([['late-pack']]);
    expect(t.frames).toHaveLength(1);
  });

  it('不相容: an installed pack that does not fit the stage API gets no entry request, no iframe, one line', async () => {
    const t = setup();
    const installed = [stagePack(ALPHA, false)];

    t.host.onView(view([actor('a1', ALPHA)], installed));
    t.host.onView(view([actor('a1', ALPHA), actor('a2', ALPHA)], installed));
    await settle();

    expect(t.requests).toStrictEqual([]);
    expect(t.frames).toHaveLength(0);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-skipped', packId: ALPHA, reason: 'api-incompatible' },
    ]);
  });

  it.each<[string, IpcResult<PackEntryResult>, string]>([
    [
      'not installed',
      { ok: true, data: { ok: false, code: 'not-installed' } },
      'not-installed',
    ],
    [
      'incompatible',
      { ok: true, data: { ok: false, code: 'api-incompatible' } },
      'api-incompatible',
    ],
    [
      'unreadable',
      { ok: true, data: { ok: false, code: 'read-failed' } },
      'read-failed',
    ],
    [
      'refused by IPC',
      { ok: false, error: { code: 'sender-rejected', message: 'x' } },
      'request-failed',
    ],
    [
      'another pack',
      {
        ok: true,
        data: { ok: true, packId: BRAVO, version: '1.0.0', source: '' },
      },
      'request-failed',
    ],
  ])(
    '不相容: main answering %s builds no iframe, logs one line, and is not asked again while the actors stay',
    async (_label, result, reason) => {
      const t = setup({ entry: () => result });

      t.host.onView(view([actor('a1', ALPHA)]));
      await settle();
      t.host.onView(view([actor('a1', ALPHA), actor('a2', ALPHA)]));
      await settle();

      expect(t.requests).toStrictEqual([[ALPHA]]);
      expect(t.frames).toHaveLength(0);
      expect(t.logs).toStrictEqual([
        { kind: 'sandbox-skipped', packId: ALPHA, reason },
      ]);

      t.host.onView(view([]));
      t.host.onView(view([actor('a3', ALPHA)]));
      await settle();
      expect(t.requests).toStrictEqual([[ALPHA], [ALPHA]]);
    },
  );

  it.each<[string, string, unknown, string, object]>([
    [
      'lockdown',
      'lockdown printed something',
      {
        type: 'sandbox.failed',
        reason: 'lockdown-output',
        removals: READY.removals,
        consoleLines: 2,
      },
      'lockdown-output',
      { removals: READY.removals, consoleLines: 2 },
    ],
    [
      'lockdown',
      'lockdown threw',
      {
        type: 'sandbox.failed',
        reason: 'lockdown-threw',
        removals: [],
        consoleLines: 0,
      },
      'lockdown-threw',
      { removals: [], consoleLines: 0 },
    ],
    [
      '入口',
      'the entry is not a factory',
      {
        type: 'sandbox.failed',
        reason: 'entry-not-factory',
        removals: READY.removals,
        consoleLines: 0,
      },
      'entry-not-factory',
      { removals: READY.removals, consoleLines: 0 },
    ],
    [
      '入口',
      'the factory threw',
      {
        type: 'sandbox.failed',
        reason: 'factory-threw',
        removals: READY.removals,
        consoleLines: 0,
      },
      'factory-threw',
      { removals: READY.removals, consoleLines: 0 },
    ],
    [
      'lockdown',
      'a ready report claims console output',
      { ...READY, consoleLines: 1 },
      'bad-report',
      {},
    ],
    [
      '移除清單',
      'a ready report has a removal that failed',
      { ...READY, removals: [{ name: 'fetch', status: 'failed' }] },
      'bad-report',
      {},
    ],
    [
      '入口',
      'a report of another shape',
      { type: 'sandbox.hello' },
      'bad-report',
      {},
    ],
    [
      '入口',
      'an uncaught error',
      { type: 'sandbox.fault', fault: 'error' },
      'worker-error',
      {},
    ],
    [
      '入口',
      'an unhandled rejection',
      { type: 'sandbox.fault', fault: 'unhandled-rejection' },
      'unhandled-rejection',
      {},
    ],
  ])(
    '%s: when %s, the iframe goes at once with one error line, and no new sandbox comes while the actors stay',
    async (_row, _label, report, reason, details) => {
      const t = setup();
      t.host.onView(view([actor('a1', ALPHA)]));
      await settle();
      t.frames[0]?.handlers.onLoad();

      t.frames[0]?.handlers.onMessage(report);
      t.frames[0]?.handlers.onMessage(READY);

      expect(t.frames[0]?.removed).toBe(true);
      expect(t.logs).toStrictEqual([
        { kind: 'sandbox-failed', packId: ALPHA, reason, ...details },
      ]);
      expect(t.host.phases()).toStrictEqual(new Map([[ALPHA, 'failed']]));

      t.host.onView(view([actor('a1', ALPHA), actor('a2', ALPHA)]));
      await settle();
      expect(t.frames).toHaveLength(1);

      // Once the actors have left and the wait is over, a new actor gets a
      // new sandbox (rebuilding with a limit is Story 3.9).
      t.host.onView(view([]));
      t.clock.advance(SANDBOX_IDLE_MS);
      expect(t.logs).toHaveLength(1);
      t.host.onView(view([actor('a3', ALPHA)]));
      await settle();
      expect(t.frames).toHaveLength(2);
    },
  );

  it('入口: the iframe saying its Worker failed, or a second ready, takes the sandbox down', async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);
    t.logs.length = 0;

    t.frames[0]?.handlers.onWorkerError();
    t.frames[1]?.handlers.onMessage(READY);

    expect(t.frames.map((frame) => frame.removed)).toStrictEqual([true, true]);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'worker-error' },
      { kind: 'sandbox-failed', packId: BRAVO, reason: 'bad-report' },
    ]);
  });

  it.each<[string, unknown]>([
    ['not an object', 'stage.log'],
    ['an unknown type', { type: 'stage.teleport', actorId: 'a1' }],
    ['an extra field', { type: 'stage.log', text: 'x', level: 'error' }],
    ['a missing field', { type: 'stage.hold', actorId: 'a1' }],
    ['a wrong type of field', { type: 'stage.hold', actorId: 'a1', on: 'yes' }],
    ['a Map', new Map([['type', 'stage.log']])],
    ['an undefined field', { type: 'stage.log', text: undefined }],
  ])(
    '訊息驗證: a message that is %s is dropped whole, with one line naming the pack',
    async (_label, data) => {
      const t = setup();
      await showReady(t, [actor('a1', ALPHA)]);
      t.logs.length = 0;

      t.frames[0]?.handlers.onMessage(data);

      expect(t.calls).toStrictEqual([]);
      expect(t.logs).toStrictEqual([
        {
          kind: 'messages-dropped',
          packId: ALPHA,
          reason: 'invalid',
          count: 1,
        },
      ]);
    },
  );

  it(`訊息驗證: a message over ${PACK_MESSAGE_MAX_BYTES} bytes is dropped as too large`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    t.logs.length = 0;

    t.frames[0]?.handlers.onMessage({
      type: 'stage.log',
      text: 'é'.repeat(PACK_MESSAGE_MAX_BYTES / 2),
    });

    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'too-large',
        count: 1,
      },
    ]);
  });

  it("不屬於該包: an actorId of another pack, or one no longer on stage, drops the message; the pack's own goes through", async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);
    t.logs.length = 0;
    const alpha = t.frames[0]?.handlers;

    alpha?.onMessage({ type: 'stage.hold', actorId: 'b1', on: true });
    alpha?.onMessage({ type: 'stage.face', actorId: 'a1', direction: 'left' });
    alpha?.onMessage({
      type: 'stage.fire',
      actorId: 'a1',
      target: 'b1',
      object: 'spark',
    });

    expect(t.calls).toStrictEqual([
      [ALPHA, { type: 'stage.face', actorId: 'a1', direction: 'left' }],
      [
        ALPHA,
        { type: 'stage.fire', actorId: 'a1', target: 'b1', object: 'spark' },
      ],
    ]);
    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'not-own-actor',
        count: 1,
      },
    ]);

    // Its actors gone (the sandbox waits out SANDBOX_IDLE_MS): none is its own.
    t.host.onView(view([actor('b1', BRAVO)]));
    t.clock.advance(PACK_DROP_LOG_INTERVAL_MS);
    alpha?.onMessage({ type: 'stage.hold', actorId: 'a1', on: false });
    expect(t.calls).toHaveLength(2);
    expect(t.logs.at(-1)).toStrictEqual({
      kind: 'messages-dropped',
      packId: ALPHA,
      reason: 'not-own-actor',
      count: 1,
    });
  });

  it(`限速: past ${PACK_MESSAGE_RATE_LIMIT} messages in ${PACK_MESSAGE_RATE_WINDOW_MS} ms the rest are dropped; drop lines come at most once per ${PACK_DROP_LOG_INTERVAL_MS} ms, counting those in between`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    t.logs.length = 0;
    const send = (count: number) => {
      for (let i = 0; i < count; i += 1) {
        t.frames[0]?.handlers.onMessage({
          type: 'stage.face',
          actorId: 'a1',
          direction: 'right',
        });
      }
    };

    send(PACK_MESSAGE_RATE_LIMIT + 5);
    expect(t.calls).toHaveLength(PACK_MESSAGE_RATE_LIMIT);
    expect(t.logs).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'rate-limited',
        count: 1,
      },
    ]);

    // A new window: all go through again.
    t.clock.advance(PACK_MESSAGE_RATE_WINDOW_MS);
    send(PACK_MESSAGE_RATE_LIMIT);
    expect(t.calls).toHaveLength(PACK_MESSAGE_RATE_LIMIT * 2);

    // Past the drop log interval, the next drop's line counts the 4 held back.
    t.clock.advance(PACK_DROP_LOG_INTERVAL_MS);
    send(PACK_MESSAGE_RATE_LIMIT + 1);
    expect(t.logs.at(-1)).toStrictEqual({
      kind: 'messages-dropped',
      packId: ALPHA,
      reason: 'rate-limited',
      count: 5,
    });

    // Drops still held back are counted when the sandbox goes.
    send(3);
    t.host.onView(view([]));
    t.clock.advance(SANDBOX_IDLE_MS);
    expect(t.logs.slice(-2)).toStrictEqual([
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'rate-limited',
        count: 3,
      },
      { kind: 'sandbox-destroyed', packId: ALPHA, reason: 'idle' },
    ]);
  });

  it(`stage.log: written with the pack id, cut to ${STAGE_LOG_MAX_LENGTH}; past ${STAGE_LOG_RATE_LIMIT} in ${STAGE_LOG_RATE_WINDOW_MS} ms the rest are dropped`, async () => {
    const t = setup();
    await showReady(t, [actor('a1', ALPHA)]);
    t.logs.length = 0;
    const log = (text: string) => {
      t.frames[0]?.handlers.onMessage({ type: 'stage.log', text });
    };

    log('hello\nworld');
    log('x'.repeat(STAGE_LOG_MAX_LENGTH + 50));
    expect(t.logs).toStrictEqual([
      { kind: 'stage-log', packId: ALPHA, text: 'hello\nworld' },
      {
        kind: 'stage-log',
        packId: ALPHA,
        text: `${'x'.repeat(STAGE_LOG_MAX_LENGTH - 1)}…`,
      },
    ]);

    for (let i = 0; i < STAGE_LOG_RATE_LIMIT; i += 1) {
      log(String(i));
    }
    expect(t.logs.filter((entry) => entry.kind === 'stage-log')).toHaveLength(
      STAGE_LOG_RATE_LIMIT,
    );
    expect(t.logs.at(-1)).toStrictEqual({
      kind: 'messages-dropped',
      packId: ALPHA,
      reason: 'log-rate-limited',
      count: 1,
    });

    t.clock.advance(STAGE_LOG_RATE_WINDOW_MS);
    log('later');
    expect(t.logs.at(-1)).toStrictEqual({
      kind: 'stage-log',
      packId: ALPHA,
      text: 'later',
    });
  });

  it('訊息驗證: before the ready report only stage.log is taken; any other call is dropped as not-ready', async () => {
    const t = setup();
    t.host.onView(view([actor('a1', ALPHA)]));
    await settle();
    t.frames[0]?.handlers.onLoad();

    t.frames[0]?.handlers.onMessage({ type: 'stage.log', text: 'loaded' });
    t.frames[0]?.handlers.onMessage({
      type: 'stage.hold',
      actorId: 'a1',
      on: true,
    });
    t.frames[0]?.handlers.onMessage(READY);
    t.frames[0]?.handlers.onMessage({
      type: 'stage.hold',
      actorId: 'a1',
      on: true,
    });

    expect(t.logs).toStrictEqual([
      { kind: 'stage-log', packId: ALPHA, text: 'loaded' },
      {
        kind: 'messages-dropped',
        packId: ALPHA,
        reason: 'not-ready',
        count: 1,
      },
      expect.objectContaining({ kind: 'sandbox-ready', packId: ALPHA }),
    ]);
    expect(t.calls).toStrictEqual([
      [ALPHA, { type: 'stage.hold', actorId: 'a1', on: true }],
    ]);
  });

  it(`入口: neither ready nor failed within ${SANDBOX_BOOT_TIMEOUT_MS} ms of adding the iframe (a document that never runs, a factory that never returns) fails the sandbox as boot-timeout`, async () => {
    const t = setup();
    t.host.onView(view([actor('a1', ALPHA)]));
    await settle();
    t.frames[0]?.handlers.onLoad();

    t.clock.advance(SANDBOX_BOOT_TIMEOUT_MS - 1);
    expect(t.frames[0]?.removed).toBe(false);
    t.clock.advance(1);

    expect(t.frames[0]?.removed).toBe(true);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-failed', packId: ALPHA, reason: 'boot-timeout' },
    ]);
    expect(t.host.phases()).toStrictEqual(new Map([[ALPHA, 'failed']]));
    t.frames[0]?.handlers.onMessage(READY);
    expect(t.logs).toHaveLength(1);
  });

  it('入口: the boot timer stops at the ready or failed report, and when the sandbox goes', async () => {
    const t = setup();
    const installed = [
      stagePack(ALPHA),
      stagePack(BRAVO),
      stagePack('charlie-pack'),
    ];
    const actors = [
      actor('a1', ALPHA),
      actor('b1', BRAVO),
      actor('c1', 'charlie-pack'),
    ];
    t.host.onView(view(actors, installed));
    await settle();
    for (const frame of t.frames) {
      frame.handlers.onLoad();
    }
    t.frames[0]?.handlers.onMessage(READY);
    t.frames[1]?.handlers.onMessage({
      type: 'sandbox.failed',
      reason: 'factory-threw',
      removals: [],
      consoleLines: 0,
    });
    // charlie-pack removed while booting: its sandbox goes at once.
    t.host.onView(view(actors, installed.slice(0, 2)));
    t.logs.length = 0;
    // Every actor is still on stage: no idle timer, and no boot timer left.
    expect(t.clock.pendingCount()).toBe(0);

    t.clock.advance(SANDBOX_BOOT_TIMEOUT_MS * 2);

    expect(t.logs).toStrictEqual([]);
    expect(t.clock.pendingCount()).toBe(0);
    expect(t.frames.map((frame) => frame.removed)).toStrictEqual([
      false,
      true,
      true,
    ]);
  });

  it('找不到包: a pack removed while its actors stay loses its sandbox at once, then gets the one not-installed line', async () => {
    const t = setup();
    const actors = [actor('a1', ALPHA)];
    await showReady(t, actors);
    t.logs.length = 0;

    t.host.onView(view(actors, [stagePack(BRAVO)]));
    t.host.onView(view(actors, [stagePack(BRAVO)]));

    expect(t.frames[0]?.removed).toBe(true);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-destroyed', packId: ALPHA, reason: 'not-installed' },
      { kind: 'sandbox-skipped', packId: ALPHA, reason: 'not-installed' },
    ]);
    expect(t.host.phases().size).toBe(0);
  });

  it('不相容: a pack that no longer fits the stage API while its actors stay loses its sandbox at once, then gets the one api-incompatible line', async () => {
    const t = setup();
    const actors = [actor('a1', ALPHA)];
    await showReady(t, actors);
    t.logs.length = 0;

    t.host.onView(view(actors, [stagePack(ALPHA, false)]));

    expect(t.frames[0]?.removed).toBe(true);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-destroyed', packId: ALPHA, reason: 'api-incompatible' },
      { kind: 'sandbox-skipped', packId: ALPHA, reason: 'api-incompatible' },
    ]);
    expect(t.requests).toStrictEqual([[ALPHA]]);
  });

  it("隱私: main is asked with the pack id only, and the sandbox gets only the entry source: no session key, source, confidence or other pack's id", async () => {
    const t = setup();

    await showReady(t, [actor('a1', ALPHA), actor('b1', BRAVO)]);

    expect(t.requests).toStrictEqual([[ALPHA], [BRAVO]]);
    for (const [i, frame] of t.frames.entries()) {
      expect(frame.handed).toHaveLength(1);
      expect(Object.keys(frame.handed[0] ?? {}).sort()).toStrictEqual([
        'source',
        'type',
      ]);
      const text = JSON.stringify(frame.handed);
      for (const secret of ['demo:', 'exact', 'session a1', 'session b1']) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toContain(i === 0 ? BRAVO : ALPHA);
    }
  });
});

/** The end of a MessageChannel the fake iframe is handed. */
interface HandedPort {
  postMessage(message: unknown): void;
}

describe('a pack updated while its actors stay', () => {
  it('its sandbox of the old version goes at once and one for the new version is built', async () => {
    let version = '1.0.0';
    const t = setup({
      entry: (packId) => ({
        ok: true,
        data: {
          ok: true,
          packId,
          version,
          source: `${SOURCE(packId)} ${version}`,
        },
      }),
    });
    const actors = [actor('a1', ALPHA)];
    await showReady(t, actors);
    t.logs.length = 0;

    version = '1.1.0';
    t.host.onView(view(actors, [{ ...stagePack(ALPHA), version: '1.1.0' }]));
    await settle();
    t.frames[1]?.handlers.onLoad();
    t.frames[1]?.handlers.onMessage(READY);

    expect(t.frames[0]?.removed).toBe(true);
    expect(t.requests).toStrictEqual([[ALPHA], [ALPHA]]);
    expect(t.frames[1]?.handed).toStrictEqual([
      { type: 'load', source: `${SOURCE(ALPHA)} 1.1.0` },
    ]);
    expect(t.logs).toStrictEqual([
      { kind: 'sandbox-destroyed', packId: ALPHA, reason: 'version-changed' },
      expect.objectContaining({
        kind: 'sandbox-ready',
        packId: ALPHA,
        version: '1.1.0',
      }),
    ]);
  });

  it('a failed sandbox of the old version gives way to one for the new version', async () => {
    const t = setup();
    const actors = [actor('a1', ALPHA)];
    t.host.onView(view(actors));
    await settle();
    t.frames[0]?.handlers.onLoad();
    t.frames[0]?.handlers.onMessage({ type: 'sandbox.fault', fault: 'error' });

    t.host.onView(view(actors, [{ ...stagePack(ALPHA), version: '2.0.0' }]));
    await settle();

    expect(t.frames).toHaveLength(2);
    expect(t.requests).toStrictEqual([[ALPHA], [ALPHA]]);
  });
});

/** A fake `<iframe>` and document for dom.ts. */
function fakeDocument() {
  const iframes: (SandboxIframeElement<HandedPort> & {
    attributes: Map<string, string>;
    onLoad: (() => void)[];
    loadOptions: unknown[];
    posted: [SandboxLoadMessage, string, HandedPort[]][];
    attached: boolean;
    srcSetAfterLoadListener: boolean;
    removed: boolean;
  })[] = [];
  const windowListeners: ((event: {
    source: unknown;
    data: unknown;
  }) => void)[] = [];
  return {
    iframes,
    windowListeners,
    createIframe() {
      const contentWindow = {
        postMessage(
          message: SandboxLoadMessage,
          origin: string,
          transfer: HandedPort[],
        ) {
          iframe.posted.push([message, origin, transfer]);
        },
      };
      let src = '';
      const iframe = {
        hidden: false as boolean | string,
        get src() {
          return src;
        },
        set src(value: string) {
          iframe.srcSetAfterLoadListener = iframe.onLoad.length > 0;
          src = value;
        },
        attributes: new Map<string, string>(),
        onLoad: [] as (() => void)[],
        loadOptions: [] as unknown[],
        posted: [] as [SandboxLoadMessage, string, HandedPort[]][],
        attached: false,
        srcSetAfterLoadListener: false,
        removed: false,
        setAttribute(name: string, value: string) {
          iframe.attributes.set(name, value);
        },
        addEventListener(
          _type: 'load',
          listener: () => void,
          options: unknown,
        ) {
          iframe.onLoad.push(listener);
          iframe.loadOptions.push(options);
        },
        contentWindow,
        remove() {
          iframe.removed = true;
        },
      };
      iframes.push(iframe);
      return iframe;
    },
    attach(iframe: { attached: boolean }) {
      iframe.attached = true;
    },
    window: {
      addEventListener(
        _type: 'message',
        listener: (event: { source: unknown; data: unknown }) => void,
      ) {
        windowListeners.push(listener);
      },
    },
  };
}

describe('the sandbox iframes (dom.ts)', () => {
  const opened: { close(): void }[] = [];

  afterEach(() => {
    for (const port of opened.splice(0)) {
      port.close();
    }
  });

  function framesOver(doc: ReturnType<typeof fakeDocument>) {
    return createDomSandboxFrames({
      createIframe: () => doc.createIframe(),
      attach: (iframe) => {
        doc.attach(iframe as unknown as { attached: boolean });
      },
      window: doc.window,
      // Node's MessageChannel: its ports' DOM-style typings differ, not
      // their behaviour.
      createChannel: () => {
        const channel = new MessageChannel();
        opened.push(channel.port1, channel.port2);
        return channel as unknown as SandboxFrameChannel<HandedPort>;
      },
    });
  }

  describe('I/O matrix', () => {
    it('第一個 actor: a hidden sandbox="allow-scripts" iframe of pack://_stage/sandbox.html; after load the source and one port go over; the Worker reports ready on it', async () => {
      const doc = fakeDocument();
      const t = setup();
      const host = createPackHost({
        api: t.api,
        frames: framesOver(doc),
        clock: {
          now: t.clock.monotonic,
          setTimer: t.clock.setTimer,
          clearTimer: t.clock.clearTimer,
        },
        logError: () => {},
      });

      host.onView(view([actor('a1', ALPHA)]));
      await settle();
      const iframe = doc.iframes[0];
      expect(doc.iframes).toHaveLength(1);
      expect(iframe?.attributes).toStrictEqual(
        new Map([['sandbox', 'allow-scripts']]),
      );
      expect(iframe?.src).toBe(SANDBOX_DOCUMENT_URL);
      expect(SANDBOX_DOCUMENT_URL).toBe('pack://_stage/sandbox.html');
      expect(iframe?.hidden).toBe(true);
      expect(iframe?.srcSetAfterLoadListener).toBe(true);
      expect(iframe?.loadOptions).toStrictEqual([{ once: true }]);
      expect(iframe?.attached).toBe(true);
      expect(iframe?.posted).toStrictEqual([]);

      for (const listener of iframe?.onLoad ?? []) {
        listener();
      }
      expect(iframe?.posted).toHaveLength(1);
      const [message, origin, transfer] = iframe?.posted[0] ?? [];
      expect(message).toStrictEqual({ type: 'load', source: SOURCE(ALPHA) });
      expect(origin).toBe('*');
      expect(transfer).toHaveLength(1);

      // The Worker's end: its report comes back on the kept end.
      transfer?.[0]?.postMessage(READY);
      await vi.waitFor(() => {
        expect(kinds(t.logs)).toStrictEqual([`sandbox-ready ${ALPHA}`]);
      });

      host.onView(view([]));
      t.clock.advance(SANDBOX_IDLE_MS);
      expect(iframe?.removed).toBe(true);
    });
  });

  it("takes { type: 'worker-error' } only from its own iframes' windows, and only exactly that", () => {
    const doc = fakeDocument();
    const frames = framesOver(doc);
    const onWorkerError = vi.fn();
    const frame = frames.create({
      onLoad: () => {},
      onMessage: () => {},
      onWorkerError,
    });
    const iframe = doc.iframes[0];
    const notify = (source: unknown, data: unknown) => {
      for (const listener of doc.windowListeners) {
        listener({ source, data });
      }
    };

    // Before load the window is not known yet.
    notify(iframe?.contentWindow, { type: 'worker-error' });
    for (const listener of iframe?.onLoad ?? []) {
      listener();
    }
    notify({}, { type: 'worker-error' });
    notify(iframe?.contentWindow, { type: 'worker-error', detail: 'x' });
    notify(iframe?.contentWindow, { type: 'ready' });
    expect(onWorkerError).not.toHaveBeenCalled();

    notify(iframe?.contentWindow, { type: 'worker-error' });
    expect(onWorkerError).toHaveBeenCalledTimes(1);

    frame.remove();
    notify(iframe?.contentWindow, { type: 'worker-error' });
    expect(onWorkerError).toHaveBeenCalledTimes(1);
    expect(iframe?.removed).toBe(true);
  });

  it('hands over once; remove() closes the port and later messages are not passed on', async () => {
    const doc = fakeDocument();
    const frames = framesOver(doc);
    const onMessage = vi.fn();
    const frame = frames.create({
      onLoad: () => {},
      onMessage,
      onWorkerError: () => {},
    });

    frame.hand({ type: 'load', source: 'a' });
    frame.hand({ type: 'load', source: 'b' });
    const posted = doc.iframes[0]?.posted ?? [];
    expect(posted.map(([message]) => message)).toStrictEqual([
      { type: 'load', source: 'a' },
    ]);

    frame.remove();
    posted[0]?.[2][0]?.postMessage({ type: 'stage.log', text: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('不合規: a message that still comes on the kept end once removed goes to no one, and its ImageBitmaps are closed (Story 3.6’s last part)', () => {
    stubImageBitmap();
    try {
      const doc = fakeDocument();
      let deliver: ((event: { data: unknown }) => void) | undefined;
      const frames = createDomSandboxFrames({
        createIframe: () => doc.createIframe(),
        attach: (iframe) => {
          doc.attach(iframe as unknown as { attached: boolean });
        },
        window: doc.window,
        // A port that still hands on what comes after close().
        createChannel: () => ({
          port1: {
            postMessage() {},
            addEventListener(
              _type: 'message',
              listener: (event: { data: unknown }) => void,
            ) {
              deliver = listener;
            },
            start() {},
            close() {},
          },
          port2: {} as HandedPort,
        }),
      });
      const onMessage = vi.fn();
      const frame = frames.create({
        onLoad: () => {},
        onMessage,
        onWorkerError: () => {},
      });
      frame.hand({ type: 'load', source: 'a' });
      const kept = new FakeImageBitmap();
      deliver?.({
        data: { type: 'draw', seq: 0, actors: { a1: [{ image: kept }] } },
      });
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(kept.closes).toBe(0);

      frame.remove();
      const late = new FakeImageBitmap();
      deliver?.({
        data: { type: 'draw', seq: 1, actors: { a1: [{ image: late }] } },
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(late.closes).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the message rules', () => {
  it('packIdOf and actorsByPack group actors by the pack of their character key', () => {
    expect(packIdOf('alpha-pack/probe-a')).toBe('alpha-pack');
    expect(
      actorsByPack([
        actor('a1', ALPHA),
        actor('b1', BRAVO),
        actor('a2', ALPHA),
      ]),
    ).toStrictEqual(
      new Map([
        [ALPHA, new Set(['a1', 'a2'])],
        [BRAVO, new Set(['b1'])],
      ]),
    );
    expect(actorsByPack([])).toStrictEqual(new Map());
  });

  it('createRateLimiter lets `limit` through per window', () => {
    let now = 0;
    const limiter = createRateLimiter(2, 100, () => now);

    expect([limiter.take(), limiter.take(), limiter.take()]).toStrictEqual([
      true,
      true,
      false,
    ]);
    now = 99;
    expect(limiter.take()).toBe(false);
    now = 100;
    expect([limiter.take(), limiter.take(), limiter.take()]).toStrictEqual([
      true,
      true,
      false,
    ]);
  });

  it('jsonBytes counts about what JSON takes, stops past the limit, and refuses what is not plain JSON data', () => {
    expect(jsonBytes({ type: 'stage.log', text: 'é😀' }, 1000)).toBe(
      Buffer.byteLength(JSON.stringify({ type: 'stage.log', text: 'é😀' })),
    );
    expect(jsonBytes([1, true, null, 'x'], 1000)).toBe(
      JSON.stringify([1, true, null, 'x']).length,
    );
    expect(jsonBytes('x'.repeat(50), 10)).toBe(11);
    const deep: unknown[] = [];
    deep.push(deep);
    expect(jsonBytes(deep, 1000)).toBe(1001);
    for (const value of [
      undefined,
      () => 1,
      10n,
      new Map(),
      new Uint8Array(2),
      { a: undefined },
    ]) {
      expect(jsonBytes(value, 1000)).toBeNull();
    }
    expect(jsonBytes(Object.create(null) as object, 1000)).toBe(2);
  });

  it('checkPackMessage: size, then schema, then whose actor', () => {
    const own = new Set(['a1']);

    expect(
      checkPackMessage({ type: 'stage.log', text: 'x' }, new Set()),
    ).toStrictEqual({
      ok: true,
      call: { type: 'stage.log', text: 'x' },
    });
    expect(
      checkPackMessage({ type: 'stage.hold', actorId: 'a1', on: true }, own),
    ).toMatchObject({ ok: true });
    expect(
      checkPackMessage({ type: 'stage.hold', actorId: 'a2', on: true }, own),
    ).toStrictEqual({ ok: false, reason: 'not-own-actor' });
    expect(
      checkPackMessage(
        { type: 'stage.hold', actorId: '__proto__', on: true },
        own,
      ),
    ).toStrictEqual({ ok: false, reason: 'invalid' });
    expect(
      checkPackMessage({ type: 'stage.log', text: 'x'.repeat(20) }, own, 10),
    ).toStrictEqual({ ok: false, reason: 'too-large' });
  });
});
