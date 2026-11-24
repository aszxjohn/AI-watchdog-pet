/**
 * overlay/context-loss (Story 3.6): what the canvas's WebGL context being
 * lost and restored stops, starts and reports, and how the world pauses
 * meanwhile (with the real world and a fake clock); and the overlay's
 * wiring of it (createContextStage), with the real world and the real
 * canvas-input.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCanvasInput } from '../../src/overlay/canvas-input';
import {
  createContextStage,
  createContextWatch,
  worldView,
  type ContextWatchOptions,
  type WorldView,
} from '../../src/overlay/context-loss';
import { createWorld, type WorldTick } from '../../src/overlay/world/world';
import type {
  CanvasGpuState,
  CanvasHover,
  IpcResult,
} from '../../src/shared/ipc';
import type { OverlayApi } from '../../src/shared/preload-api';
import type { StageView } from '../../src/shared/stage-view';
import { fakeClock } from '../helpers/fake-clock';

const OK: IpcResult<null> = { ok: true, data: null };

/** A fake overlay API that records the `canvas:gpu` reports, in order. */
function fakeApi(reply: () => Promise<IpcResult<null>> = async () => OK): {
  api: Pick<OverlayApi, 'canvas'>;
  reports: CanvasGpuState[];
} {
  const reports: CanvasGpuState[] = [];
  const api: Pick<OverlayApi, 'canvas'> = {
    canvas: {
      ready: async () => OK,
      setHover: async () => OK,
      contextMenu: async () => OK,
      gpu: (state) => {
        reports.push(state);
        return reply();
      },
    },
  };
  return { api, reports };
}

function setup(options: Partial<ContextWatchOptions> = {}) {
  const { api, reports } = fakeApi();
  const order: string[] = [];
  const logError = vi.fn();
  const watch = createContextWatch({
    api,
    halt: () => {
      order.push('halt');
    },
    resume: () => {
      order.push('resume');
    },
    logError,
    ...options,
  });
  return { watch, reports, order, logError };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const AWAKE = { suspended: false, locked: false };

function view(
  actorIds: readonly string[],
): Pick<StageView, 'actors' | 'power'> {
  return {
    actors: actorIds.map((actorId) => ({
      actorId,
      sessionKey: `demo:${actorId}`,
      characterKey: 'sample-pack/probe-a',
      state: 'working',
      confidence: 'exact',
      displayName: null,
    })),
    power: AWAKE,
  };
}

describe('I/O matrix', () => {
  it('context lost 後還原: lost stops the drawing and tells main; restored draws again and tells main', () => {
    const { watch, reports, order } = setup();
    expect(watch.isLost()).toBe(false);

    watch.lost();
    expect(watch.isLost()).toBe(true);
    expect(order).toStrictEqual(['halt']);
    expect(reports).toStrictEqual(['context-lost']);

    watch.restored();
    expect(watch.isLost()).toBe(false);
    expect(order).toStrictEqual(['halt', 'resume']);
    expect(reports).toStrictEqual(['context-lost', 'context-restored']);
  });

  it('context lost 後還原: while lost the world does not tick (no frame) and stage time stands still; restored, it goes on with the actors that came meanwhile', () => {
    const clock = fakeClock();
    const ticks: WorldTick[] = [];
    const world = createWorld({
      clock: {
        now: clock.monotonic,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      onTick: (tick) => {
        ticks.push(tick);
      },
      logError: () => {},
    });
    let current = view(['a1']);
    const watch = createContextWatch({
      api: undefined,
      halt: () => {
        world.onView(worldView(current, true));
      },
      resume: () => {
        world.onView(current);
      },
    });
    world.onView(worldView(current, watch.isLost()));
    clock.advance(100);
    const before = ticks.length;
    const t = world.time();

    watch.lost();
    current = view(['a1', 'a2']);
    world.onView(worldView(current, watch.isLost()));
    clock.advance(2_000);
    expect(ticks).toHaveLength(before);
    expect(world.running()).toBe(false);
    expect(world.time()).toBe(t);

    watch.restored();
    clock.advance(0);
    expect(ticks.length).toBeGreaterThan(before);
    expect(ticks[before]?.events).toStrictEqual([
      { type: 'enter', actorId: 'a2' },
    ]);
    expect(ticks[before]?.t).toBe(t);
  });

  it('context lost 後還原: worldView reads the power as asleep only while lost, keeping the actors and the lock', () => {
    const shown = view(['a1']);
    const locked = { ...shown, power: { suspended: false, locked: true } };

    expect(worldView(shown, false)).toBe(shown);
    expect(worldView(shown, true)).toStrictEqual({
      actors: shown.actors,
      power: { suspended: true, locked: false },
    });
    expect(worldView(locked, true).power).toStrictEqual({
      suspended: true,
      locked: true,
    });
  });

  it('重複事件: lost twice, or restored with nothing lost, stops, starts and reports nothing more', () => {
    const { watch, reports, order } = setup();

    watch.restored();
    watch.lost();
    watch.lost();
    watch.restored();
    watch.restored();

    expect(order).toStrictEqual(['halt', 'resume']);
    expect(reports).toStrictEqual(['context-lost', 'context-restored']);
  });

  it('壞輸入: a report main answers with an error is logged on the console; drawing goes on as it is', async () => {
    const { api } = fakeApi(async () => ({
      ok: false,
      error: { code: 'sender-rejected', message: 'nope' },
    }));
    const logError = vi.fn();
    const watch = createContextWatch({
      api,
      halt: () => {},
      resume: () => {},
      logError,
    });

    watch.lost();
    await settle();

    expect(watch.isLost()).toBe(true);
    expect(logError.mock.calls).toStrictEqual([
      ['[overlay] canvas:gpu: sender-rejected: nope'],
    ]);
  });

  it('壞輸入: a report that rejects, or a halt that throws, is logged; the state still changes and main still hears it', async () => {
    const failure = new Error('gone');
    const { api, reports } = fakeApi(() => Promise.reject(failure));
    const logError = vi.fn();
    const watch = createContextWatch({
      api,
      halt: () => {
        throw failure;
      },
      resume: () => {},
      logError,
    });

    watch.lost();
    await settle();

    expect(watch.isLost()).toBe(true);
    expect(reports).toStrictEqual(['context-lost']);
    expect(logError.mock.calls).toStrictEqual([
      ['[overlay] stopping the drawing failed', failure],
      ['[overlay] canvas:gpu failed', failure],
    ]);
  });

  it('壞輸入: without the preload API, drawing still stops and starts; nothing is reported', () => {
    const order: string[] = [];
    const watch = createContextWatch({
      api: undefined,
      halt: () => order.push('halt'),
      resume: () => order.push('resume'),
    });

    watch.lost();
    watch.restored();

    expect(order).toStrictEqual(['halt', 'resume']);
  });
});

/**
 * The overlay's wiring (createContextStage) with the real world and the
 * real canvas-input, and fakes for the rest: the render loop, PixiJS's
 * resizing, the data attributes, the canvas following the view, and the
 * canvas's context events.
 */
function stageSetup(options: { lostAtAttach?: boolean } = {}) {
  const clock = fakeClock();
  const ticks: WorldTick[] = [];
  const world = createWorld({
    clock: {
      now: clock.monotonic,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
    onTick: (tick) => {
      ticks.push(tick);
    },
    logError: () => {},
  });
  const hovers: CanvasHover[] = [];
  const reports: CanvasGpuState[] = [];
  const api: Pick<OverlayApi, 'canvas'> = {
    canvas: {
      ready: async () => OK,
      setHover: async (hover) => {
        hovers.push(hover);
        return OK;
      },
      contextMenu: async () => OK,
      gpu: async (state) => {
        reports.push(state);
        return OK;
      },
    },
  };
  const input = createCanvasInput({ api, logError: () => {} });
  const loop = { running: false, resizing: true, pauses: 0 };
  const shown = new Map<string, string>();
  const followed: WorldView[] = [];
  let current: WorldView | undefined = view(['a1']);
  const stage = createContextStage<WorldView>({
    api,
    world,
    input,
    ticker: {
      started: () => loop.running,
      stop: () => {
        loop.running = false;
      },
    },
    resize: {
      pause: () => {
        loop.resizing = false;
        loop.pauses += 1;
      },
      resume: () => {
        loop.resizing = true;
      },
    },
    show: (key, value) => {
      shown.set(key, value);
    },
    view: () => current,
    follow: (next) => {
      followed.push(next);
      loop.running = true;
    },
  });
  const events = new Map<string, () => void>();
  stage.attach({
    on: (event, listener) => {
      events.set(event, listener);
    },
    isContextLost: () => options.lostAtAttach ?? false,
  });
  return {
    clock,
    ticks,
    world,
    input,
    hovers,
    reports,
    loop,
    shown,
    followed,
    stage,
    /** StageView changes to `next`: what main.ts does with it. */
    setView(next: WorldView) {
      current = next;
      stage.onView(next);
    },
    /** The canvas fires `event`. */
    fire(event: 'webglcontextlost' | 'webglcontextrestored') {
      events.get(event)?.();
    },
  };
}

/** The one character's area: 100 × 100 DIP at the origin. */
const AREA = { key: 'demo:a1', x: 0, y: 0, width: 100, height: 100 } as const;

describe('I/O matrix', () => {
  it('context lost 後還原: lost, the world stops ticking (no frame), the render loop and resizing stop, the cursor over a character gets click-through back, the data attributes say nothing is drawn; main hears it', () => {
    const t = stageSetup();
    t.setView(view(['a1']));
    t.loop.running = true;
    t.clock.advance(100);
    t.input.setAreas([AREA]);
    t.input.onMouseMove({ x: 10, y: 10 });
    expect(t.hovers).toStrictEqual([{ seq: 1, over: true }]);
    const before = t.ticks.length;
    expect(before).toBeGreaterThan(0);

    t.fire('webglcontextlost');

    expect(t.world.running()).toBe(false);
    t.clock.advance(1_000);
    expect(t.ticks).toHaveLength(before);
    expect(t.loop).toStrictEqual({
      running: false,
      resizing: false,
      pauses: 1,
    });
    expect(t.hovers).toStrictEqual([
      { seq: 1, over: true },
      { seq: 2, over: false },
    ]);
    // Nothing takes the mouse while lost.
    t.input.onMouseMove({ x: 20, y: 20 });
    expect(t.hovers).toHaveLength(2);
    expect(Object.fromEntries(t.shown)).toStrictEqual({
      context: 'lost',
      drawnActors: '0',
      drawnSprites: '0',
      // The bitmaps too (Story 3.6's last part).
      drawnBitmaps: '0',
      // The particles too (Story 3.6's second last part).
      particleEmitters: '0',
      liveParticles: '0',
      drawnEmitters: '0',
      drawnParticles: '0',
      hitAreas: '0',
    });
    expect(t.reports).toStrictEqual(['context-lost']);
  });

  it('context lost 後還原: StageView changes while lost keep the world paused', () => {
    const t = stageSetup();
    t.setView(view(['a1']));
    t.clock.advance(100);
    t.fire('webglcontextlost');
    const before = t.ticks.length;

    t.setView(view(['a1', 'a2']));
    t.clock.advance(2_000);

    expect(t.world.running()).toBe(false);
    expect(t.ticks).toHaveLength(before);
    expect(t.followed).toStrictEqual([]);
  });

  it('context lost 後還原: restored, resizing and the world go on with the actors that came meanwhile, the canvas follows the latest view; main hears it', () => {
    const t = stageSetup();
    t.setView(view(['a1']));
    t.clock.advance(100);
    t.fire('webglcontextlost');
    const before = t.ticks.length;
    const latest = view(['a1', 'a2']);
    t.setView(latest);

    t.fire('webglcontextrestored');
    t.clock.advance(0);

    expect(t.loop.resizing).toBe(true);
    expect(t.followed).toStrictEqual([latest]);
    expect(t.loop.running).toBe(true);
    expect(t.world.running()).toBe(true);
    expect(t.ticks[before]?.events).toStrictEqual([
      { type: 'enter', actorId: 'a2' },
    ]);
    expect(t.shown.get('context')).toBe('ok');
    expect(t.reports).toStrictEqual(['context-lost', 'context-restored']);
  });

  it('context lost 後還原: a context already lost when the canvas is attached (lost while PixiJS initialised) is handled as lost at once; main hears it', () => {
    const t = stageSetup({ lostAtAttach: true });

    expect(t.stage.isLost()).toBe(true);
    expect(t.shown.get('context')).toBe('lost');
    expect(t.loop.resizing).toBe(false);
    expect(t.reports).toStrictEqual(['context-lost']);
    // StageView arriving later keeps the world paused.
    t.setView(view(['a1']));
    t.clock.advance(1_000);
    expect(t.ticks).toStrictEqual([]);
  });

  it('context lost 後還原: attached with a working context, the data attribute says ok and main hears nothing', () => {
    const t = stageSetup();

    expect(t.stage.isLost()).toBe(false);
    expect(t.shown.get('context')).toBe('ok');
    expect(t.reports).toStrictEqual([]);
  });

  it('重複事件: the canvas firing lost twice stops things once and tells main once', () => {
    const t = stageSetup();

    t.fire('webglcontextlost');
    t.fire('webglcontextlost');
    t.fire('webglcontextrestored');
    t.fire('webglcontextrestored');

    expect(t.loop.pauses).toBe(1);
    expect(t.reports).toStrictEqual(['context-lost', 'context-restored']);
  });
});
