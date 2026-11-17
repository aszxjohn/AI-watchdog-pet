/**
 * overlay/world (Story 3.6): the tick (with a fake clock), its pause, its
 * time and events; the row the actors stand in; which state a pack gets;
 * the canvas resolution.
 */
import { describe, expect, it, vi } from 'vitest';
import { rowLayout } from '../../src/overlay/world/layout';
import { mappedState, sentState } from '../../src/overlay/world/states';
import {
  canvasResolution,
  createWorld,
  isPaused,
  tickEvents,
  TICK_MS,
  type WorldTick,
} from '../../src/overlay/world/world';
import {
  STAGE_ROW_BOTTOM_MARGIN,
  STAGE_ROW_GAP,
  STAGE_ROW_RIGHT_MARGIN,
  TICK_HZ,
} from '../../src/shared/constants';
import type { StageView } from '../../src/shared/stage-view';
import { fakeClock } from '../helpers/fake-clock';

const AWAKE = { suspended: false, locked: false };

function view(
  actorIds: readonly string[],
  power: StageView['power'] = AWAKE,
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
    power,
  };
}

function setup() {
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
  return { clock, ticks, world };
}

describe('I/O matrix', () => {
  it(`出現: with an actor on stage the world ticks ${TICK_HZ} times a second, t in ms from the first tick`, () => {
    const t = setup();
    t.world.onView(view(['a1']));
    t.clock.advance(0);

    expect(t.ticks).toHaveLength(1);
    // A hair more: the fake timers add up floating-point delays.
    t.clock.advance(1000 + 1e-6);

    expect(t.ticks).toHaveLength(TICK_HZ + 1);
    expect(t.ticks[0]?.t).toBe(0);
    expect(t.ticks[1]?.t).toBeCloseTo(TICK_MS, 6);
    expect(t.ticks.at(-1)?.t).toBeCloseTo(1000, 6);
    expect(t.world.running()).toBe(true);
  });

  it('加入與移出: each tick carries enter for the actors that came and leave for those gone since the previous tick', () => {
    const t = setup();
    t.world.onView(view(['a1']));
    t.clock.advance(0);
    t.world.onView(view(['a1', 'b1']));
    t.clock.advance(TICK_MS);
    t.world.onView(view(['b1']));
    t.clock.advance(TICK_MS);
    t.clock.advance(TICK_MS);

    expect(t.ticks.map((tick) => tick.events)).toStrictEqual([
      [{ type: 'enter', actorId: 'a1' }],
      [{ type: 'enter', actorId: 'b1' }],
      [{ type: 'leave', actorId: 'a1' }],
      [],
    ]);
  });

  it.each([
    ['asleep', { suspended: true, locked: false }],
    ['locked', { suspended: false, locked: true }],
    ['asleep and locked', { suspended: true, locked: true }],
  ] as const)(
    '暫停: %s, the world does not tick (so no frame is sent); once both are over it goes on, t taking up where it stood',
    (_label, power) => {
      const t = setup();
      t.world.onView(view(['a1']));
      t.clock.advance(TICK_MS * 3);
      const before = t.ticks.length;
      const stoodAt = t.world.time();

      t.world.onView(view(['a1'], power));
      t.clock.advance(60_000);
      expect(t.ticks).toHaveLength(before);
      expect(t.world.running()).toBe(false);
      expect(t.world.time()).toBe(stoodAt);

      t.world.onView(view(['a1']));
      t.clock.advance(0);
      expect(t.ticks).toHaveLength(before + 1);
      expect(t.ticks.at(-1)?.t).toBe(stoodAt);
      t.clock.advance(TICK_MS);
      expect(t.ticks.at(-1)?.t).toBeCloseTo(stoodAt + TICK_MS, 6);
    },
  );

  it('暫停: an actor that came while paused is an enter at the first tick after', () => {
    const t = setup();
    t.world.onView(view(['a1']));
    t.clock.advance(0);
    t.world.onView(view(['a1', 'b1'], { suspended: true, locked: false }));
    t.clock.advance(1000);
    t.world.onView(view(['a1', 'b1']));
    t.clock.advance(0);

    expect(t.ticks.at(-1)?.events).toStrictEqual([
      { type: 'enter', actorId: 'b1' },
    ]);
  });
});

describe('createWorld', () => {
  it('does not tick with no actor; once the last leaves, one more tick tells who left, then it stops, and starts afresh when one comes', () => {
    const t = setup();
    t.world.onView(view([]));
    t.clock.advance(1000);
    expect(t.ticks).toStrictEqual([]);
    expect(t.clock.pendingCount()).toBe(0);

    t.world.onView(view(['a1']));
    t.clock.advance(TICK_MS);
    const count = t.ticks.length;
    t.world.onView(view([]));
    expect(t.world.running()).toBe(true);
    t.clock.advance(1000);
    expect(t.ticks).toHaveLength(count + 1);
    expect(t.ticks.at(-1)?.events).toStrictEqual([
      { type: 'leave', actorId: 'a1' },
    ]);
    expect(t.world.running()).toBe(false);
    expect(t.clock.pendingCount()).toBe(0);

    t.world.onView(view(['b1']));
    t.clock.advance(0);
    expect(t.ticks).toHaveLength(count + 2);
    expect(t.ticks.at(-1)?.events).toStrictEqual([
      { type: 'enter', actorId: 'b1' },
    ]);
  });

  it('paused with the last actor gone: no tick while paused; once it goes on, one tick tells who left, then it stops', () => {
    const t = setup();
    t.world.onView(view(['a1']));
    t.clock.advance(0);
    t.world.onView(view([], { suspended: true, locked: false }));
    t.clock.advance(1000);
    expect(t.ticks).toHaveLength(1);

    t.world.onView(view([]));
    t.clock.advance(1000);
    expect(t.ticks).toHaveLength(2);
    expect(t.ticks.at(-1)?.events).toStrictEqual([
      { type: 'leave', actorId: 'a1' },
    ]);
    expect(t.world.running()).toBe(false);
  });

  it('a tick so late the next is already due brings no burst: one tick, then the next a period after it', () => {
    const clock = fakeClock();
    const ticks: number[] = [];
    let busy = 0;
    const world = createWorld({
      clock: {
        now: () => clock.monotonic() + busy,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      onTick: (tick) => {
        ticks.push(tick.t);
      },
    });
    world.onView(view(['a1']));
    clock.advance(0);
    // The page was busy for 10 periods when the next timer fired.
    busy = TICK_MS * 10;
    clock.advance(TICK_MS + 1e-6);
    expect(ticks).toHaveLength(2);
    // The grid starts again from that late tick: the next is a period on.
    clock.advance(TICK_MS - 1e-3);
    expect(ticks).toHaveLength(2);
    clock.advance(2e-3);
    expect(ticks).toHaveLength(3);
  });

  it('a throwing onTick is logged and the ticks go on', () => {
    const clock = fakeClock();
    const logError = vi.fn();
    let count = 0;
    const world = createWorld({
      clock: {
        now: clock.monotonic,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      onTick: () => {
        count += 1;
        throw new Error('boom');
      },
      logError,
    });
    world.onView(view(['a1']));
    clock.advance(TICK_MS * 2 + 1e-6);

    expect(count).toBe(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it('isPaused: asleep or locked', () => {
    expect(isPaused(AWAKE)).toBe(false);
    expect(isPaused({ suspended: true, locked: false })).toBe(true);
    expect(isPaused({ suspended: false, locked: true })).toBe(true);
  });

  it('tickEvents: enters in the order given, then leaves in the order they were', () => {
    expect(tickEvents(new Set(['a', 'b', 'c']), ['d', 'b', 'e'])).toStrictEqual(
      [
        { type: 'enter', actorId: 'd' },
        { type: 'enter', actorId: 'e' },
        { type: 'leave', actorId: 'a' },
        { type: 'leave', actorId: 'c' },
      ],
    );
    expect(tickEvents(new Set(), [])).toStrictEqual([]);
  });
});

describe('I/O matrix', () => {
  const WORLD = { width: 1512, height: 982 };
  const BOUNDS = { x: -40, width: 80 };

  it('大小與排序: the first actor rightmost, each as wide as its bounds × 大小 plus the gap, feet above the bottom margin', () => {
    const placed = rowLayout(WORLD, [
      { key: 'a1', bounds: BOUNDS, scale: 1 },
      { key: 'a2', bounds: BOUNDS, scale: 1.5 },
      { key: 'a3', bounds: { x: -10, width: 50 }, scale: 0.5 },
    ]);

    const feet = WORLD.height - STAGE_ROW_BOTTOM_MARGIN;
    const right1 = WORLD.width - STAGE_ROW_RIGHT_MARGIN;
    const left1 = right1 - 80;
    const left2 = left1 - STAGE_ROW_GAP - 120;
    const left3 = left2 - STAGE_ROW_GAP - 25;
    expect([...placed]).toStrictEqual([
      ['a1', { x: left1 + 40, y: feet }],
      ['a2', { x: left2 + 60, y: feet }],
      ['a3', { x: left3 + 5, y: feet }],
    ]);
  });

  it('大小與排序: a new actor (StageView adds it last) never moves the ones already there', () => {
    const one = rowLayout(WORLD, [{ key: 'a1', bounds: BOUNDS, scale: 1 }]);
    const two = rowLayout(WORLD, [
      { key: 'a1', bounds: BOUNDS, scale: 1 },
      { key: 'a2', bounds: BOUNDS, scale: 2 },
    ]);
    expect(two.get('a1')).toStrictEqual(one.get('a1'));
  });

  it('大小與排序: the first one that does not fit, and every one after it, gets no place (not drawn)', () => {
    const placed = rowLayout({ width: 300, height: 200 }, [
      { key: 'a1', bounds: BOUNDS, scale: 1 },
      { key: 'a2', bounds: BOUNDS, scale: 2 },
      { key: 'a3', bounds: BOUNDS, scale: 1 },
      { key: 'a4', bounds: { x: 0, width: 1 }, scale: 1 },
    ]);
    expect([...placed.keys()]).toStrictEqual(['a1', 'a2']);
    // A world shorter than the margin keeps the feet at its top edge.
    expect(placed.get('a1')?.y).toBe(200 - STAGE_ROW_BOTTOM_MARGIN);
    expect(
      rowLayout({ width: 300, height: 50 }, [
        { key: 'a1', bounds: BOUNDS, scale: 1 },
      ]).get('a1')?.y,
    ).toBe(0);
  });

  const PROBE = {
    states: ['waiting', 'thinking', 'working'] as const,
    fallback: { done: 'waiting', idle: 'waiting' } as const,
  };

  it('狀態改變: a state in states goes as it is; one with a fallback goes as its fallback', () => {
    expect(
      mappedState({ ...PROBE, states: [...PROBE.states] }, 'thinking'),
    ).toBe('thinking');
    expect(mappedState({ ...PROBE, states: [...PROBE.states] }, 'done')).toBe(
      'waiting',
    );
    expect(sentState({ ...PROBE, states: [...PROBE.states] }, 'idle')).toBe(
      'waiting',
    );
  });

  it('狀態對應不到: in neither states nor fallback: no mapped state (not drawn), and the pack is sent the state itself', () => {
    const character = { ...PROBE, states: [...PROBE.states] };
    expect(mappedState(character, 'approval')).toBeNull();
    expect(sentState(character, 'approval')).toBe('approval');
    expect(mappedState({ states: ['working'] }, 'error')).toBeNull();
  });

  it("換螢幕: the canvas draws at its display's scaleFactor; until it is placed, at what it has", () => {
    const canvas = {
      displayId: 2,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.25,
      fallback: false,
    };
    expect(canvasResolution(canvas, 2)).toBe(1.25);
    expect(canvasResolution({ ...canvas, scaleFactor: 2 }, 1.25)).toBe(2);
    expect(canvasResolution(null, 2)).toBe(2);
  });
});
