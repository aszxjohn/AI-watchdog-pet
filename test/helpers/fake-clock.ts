/**
 * A fake monotonic clock and wall clock, with fake timers on the monotonic
 * one, for main/detection. Awake, both clocks move together; asleep
 * (sleep()), only the wall clock moves and no timer fires, as on macOS.
 */

/** Where the fake clocks start. */
export const MONO_START = 50_000;
export const WALL_START = 1_762_675_200_000;

/** Most timers one advance() may fire before the test gives up. */
const MAX_TIMER_RUNS = 100_000;

interface Timer {
  readonly at: number;
  readonly run: () => void;
}

export interface FakeClock {
  readonly monotonic: () => number;
  readonly wall: () => number;
  readonly setTimer: (run: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: unknown) => void;
  /** How many timers are set. */
  pendingCount(): number;
  /**
   * Moves both clocks forward by `ms`, firing each timer due by then at its
   * own time, in time order.
   */
  advance(ms: number): void;
  /**
   * The system sleeps for `ms`: the wall clock moves, the monotonic clock
   * does not, and no timer fires.
   */
  sleep(ms: number): void;
}

export function fakeClock(): FakeClock {
  let mono = MONO_START;
  let wall = WALL_START;
  let nextId = 1;
  const timers = new Map<number, Timer>();

  return {
    monotonic: () => mono,
    wall: () => wall,
    setTimer(run, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: mono + delayMs, run });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    pendingCount: () => timers.size,
    advance(ms) {
      const end = mono + ms;
      for (let runs = 0; ; runs += 1) {
        if (runs > MAX_TIMER_RUNS) {
          throw new Error('timers keep firing');
        }
        let next: [number, Timer] | undefined;
        for (const entry of timers) {
          if (
            entry[1].at <= end &&
            (next === undefined || entry[1].at < next[1].at)
          ) {
            next = entry;
          }
        }
        if (next === undefined) {
          break;
        }
        timers.delete(next[0]);
        wall += next[1].at - mono;
        mono = next[1].at;
        next[1].run();
      }
      wall += end - mono;
      mono = end;
    },
    sleep(ms) {
      wall += ms;
    },
  };
}
