/**
 * main/detection/clock: the monotonic clock main/detection times sessions
 * with, made to count sleep.
 *
 * On macOS the monotonic clock (`performance.now()`, libuv's
 * `mach_absolute_time`) does not move while the system sleeps, so a laptop
 * closed overnight would wake with every `idle`, `done`, `error` and expiry
 * a whole night late. This clock is the monotonic one plus an offset: at
 * `resume()` the wall time that passed since `suspend()` minus the
 * monotonic time that passed is added to it (0 when that is negative, as
 * when the wall clock was set back or the monotonic clock kept counting).
 * The caller then re-evaluates whatever it timed (sessions.retime()).
 *
 * Only that one difference is ever added, so a wall-clock change while the
 * system is awake moves nothing. The offset never shrinks, so now() never
 * goes back.
 */

export interface SleepClockOptions {
  /** The monotonic clock in ms (default `performance.now`). */
  readonly monotonic?: () => number;
  /** The wall clock in epoch ms (default `Date.now`). */
  readonly wall?: () => number;
}

export interface SleepClock {
  /** Monotonic time plus all the sleep counted so far, in ms. */
  now(): number;
  /**
   * The system is about to sleep: remembers both clocks. A second call
   * before resume() keeps the first one's readings.
   */
  suspend(): void;
  /**
   * The system woke up: adds the sleep since suspend() to the offset and
   * answers how many ms that was (0 or more); null, and nothing added, when
   * there was no suspend() since the last resume().
   */
  resume(): number | null;
}

export function createSleepClock({
  monotonic = () => performance.now(),
  wall = Date.now,
}: SleepClockOptions = {}): SleepClock {
  let offset = 0;
  let suspendedAt: {
    readonly monotonic: number;
    readonly wall: number;
  } | null = null;

  return {
    now: () => monotonic() + offset,

    suspend() {
      if (suspendedAt === null) {
        suspendedAt = { monotonic: monotonic(), wall: wall() };
      }
    },

    resume() {
      if (suspendedAt === null) {
        return null;
      }
      const slept = Math.max(
        0,
        wall() - suspendedAt.wall - (monotonic() - suspendedAt.monotonic),
      );
      suspendedAt = null;
      offset += slept;
      return slept;
    },
  };
}
