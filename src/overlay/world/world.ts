/**
 * overlay/world (Story 3.6, AD-11): the stage's tick, its one owner. Pure
 * logic with the clock passed in, so it is unit-tested under Node.
 *
 * - It ticks TICK_HZ times a second while there is an actor on stage
 *   (StageView's `actors`) and the stage is not paused; otherwise it does
 *   not tick at all.
 * - Paused: while StageView's `power` says the system is asleep or the
 *   screen is locked. No tick, so no `frame`, while paused; ticking goes on
 *   once both are over.
 * - Each tick hands `onTick` the stage time `t` and the tick's events.
 *   `t` is in milliseconds and moves only while ticking: it stands still
 *   while paused or with no actor, and goes on from there, so it never
 *   jumps and never goes back. The events are the actors (any pack's) that
 *   came on stage or left since the previous tick, by `actorId`: `enter`
 *   for each new one, in StageView's order, then `leave` for each gone,
 *   in the order they were. Once the last actor has left, one more tick
 *   tells the packs (their `leave` events, their `despawn`s), then the
 *   stage stops ticking; the next run starts with no one before. Paused,
 *   it stops at once (and tells them once it goes on).
 * - Ticks are due every 1000 / TICK_HZ ms from the first (on that grid,
 *   so they do not drift); one so late that the next is already due does
 *   not bring a burst of the ones missed: the grid starts again from it.
 */
import { TICK_HZ } from '../../shared/constants';
import type { FrameEvent } from '../../shared/pack-api';
import type {
  StageCanvas,
  StagePower,
  StageView,
} from '../../shared/stage-view';

/** Milliseconds between ticks. */
export const TICK_MS = 1000 / TICK_HZ;

/** A monotonic clock in milliseconds, with timers. */
export interface WorldClock {
  now(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** What one tick gives. */
export interface WorldTick {
  /** Stage time, ms (see the module comment). */
  readonly t: number;
  /** The actors that came on stage or left since the previous tick. */
  readonly events: readonly FrameEvent[];
}

export interface WorldOptions {
  readonly clock: WorldClock;
  /** Hears each tick. A throw is logged and the ticking goes on. */
  readonly onTick: (tick: WorldTick) => void;
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

export interface World {
  /** Follows a StageView state: its `actors` and `power`. */
  onView(view: Pick<StageView, 'actors' | 'power'>): void;
  /** Whether it is ticking. */
  running(): boolean;
  /** Stage time now, ms. */
  time(): number;
}

/** Whether `power` pauses the stage: asleep, or the screen locked. */
export function isPaused(power: StagePower): boolean {
  return power.suspended || power.locked;
}

/**
 * The resolution the canvas draws at (Story 3.6): its display's
 * `scaleFactor`, so a canvas moved to a display of another scale stays
 * sharp and the same size in DIP; `current` while the canvas is not placed.
 */
export function canvasResolution(canvas: StageCanvas, current: number): number {
  return canvas === null ? current : canvas.scaleFactor;
}

/**
 * The events from `before` (the actor ids of the previous tick) to
 * `now` (this tick's, in order): `enter` for each new id, then `leave`
 * for each gone one.
 */
export function tickEvents(
  before: ReadonlySet<string>,
  now: readonly string[],
): FrameEvent[] {
  const current = new Set(now);
  return [
    ...now
      .filter((actorId) => !before.has(actorId))
      .map((actorId): FrameEvent => ({ type: 'enter', actorId })),
    ...[...before]
      .filter((actorId) => !current.has(actorId))
      .map((actorId): FrameEvent => ({ type: 'leave', actorId })),
  ];
}

export function createWorld({
  clock,
  onTick,
  logError = console.error,
}: WorldOptions): World {
  /** The latest StageView's actor ids, in order. */
  let actorIds: readonly string[] = [];
  let paused = false;
  /** Stage time banked before the current run. */
  let banked = 0;
  /** When the current run started (clock time), or null when stopped. */
  let since: number | null = null;
  /** Where the ticks' grid starts (clock time), and the ticks on it so far. */
  let gridStart = 0;
  let ticked = 0;
  let timer: unknown;
  /** The previous tick's actor ids. */
  let previous: ReadonlySet<string> = new Set();

  function time(): number {
    return since === null ? banked : banked + (clock.now() - since);
  }

  /** When tick number `count` on the grid is due. */
  function dueAt(count: number): number {
    return gridStart + (count * 1000) / TICK_HZ;
  }

  function schedule(): void {
    timer = clock.setTimer(tick, Math.max(0, dueAt(ticked) - clock.now()));
  }

  function tick(): void {
    timer = undefined;
    if (since === null) {
      return;
    }
    const now = clock.now();
    ticked += 1;
    if (now >= dueAt(ticked)) {
      // So late the next one is due already: no burst, a new grid.
      gridStart = now;
      ticked = 1;
    }
    const events = tickEvents(previous, actorIds);
    previous = new Set(actorIds);
    try {
      onTick({ t: time(), events });
    } catch (error) {
      logError('[overlay] a world tick failed', error);
    }
    if (actorIds.length === 0) {
      // Everyone has been told who left: nothing to tick for.
      stop();
      previous = new Set();
    }
    if (since !== null) {
      schedule();
    }
  }

  function start(): void {
    if (since !== null) {
      return;
    }
    since = clock.now();
    gridStart = since;
    ticked = 0;
    schedule();
  }

  function stop(): void {
    if (since === null) {
      return;
    }
    banked = time();
    since = null;
    if (timer !== undefined) {
      clock.clearTimer(timer);
      timer = undefined;
    }
  }

  return {
    onView(view) {
      actorIds = view.actors.map((actor) => actor.actorId);
      paused = isPaused(view.power);
      if (paused) {
        stop();
      } else if (actorIds.length > 0 || previous.size > 0) {
        // With no actor left, it ticks once more to tell who left (tick()).
        start();
      }
    },

    running: () => since !== null,

    time,
  };
}
