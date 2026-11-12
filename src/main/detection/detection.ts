/**
 * main/detection (AD-5, AD-21): holds the session list
 * (main/detection/sessions), the health of each running adapter and demo
 * mode, and owns StageView's `sessions` and `adapters` sections, offered to
 * main/stage-view the way main/windows offers its own (get() and
 * onChange()). main.ts only wires it up; nothing here imports
 * main/windows.
 *
 * - Every adapter output goes to sessions.receive, demo mode's included.
 * - Timings are main/settings' current values. On every settings change
 *   the sessions are evaluated again at once (sessions.retime()), and demo
 *   mode sends its state again if a timing it depends on changed.
 * - Sleep: sessions are timed with a clock that counts it
 *   (main/detection/clock). On resume the sleep is added, demo mode sends
 *   its state again (its repeats did not run while asleep, and its session
 *   may have expired), and the sessions are evaluated again.
 * - Demo mode is off at every start and never saved. Turning it on starts
 *   the demo adapter (health `ok`); turning it off stops it, which ends its
 *   session.
 * - The source adapters it is given (main.ts: Claude Code's and Gemini
 *   CLI's) start with it and stop with it. Each reports its health itself;
 *   what one read of theirs produced reaches sessions as one change.
 * - One change, one notification: what a demo switch, a settings change or
 *   a resume does to the sections is heard once, when it is done. Listeners
 *   hear only the sections that changed.
 */
import type { AdapterOutput } from '../../shared/detection-events';
import type { DetectionTimings, SettingsState } from '../../shared/settings';
import type { AdapterHealth, SourceCode } from '../../shared/sources';
import type { StageViewDetectionSections } from '../../shared/stage-view';
import type { StateCode } from '../../shared/states';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import type { AdapterContext, DetectionAdapter } from './adapter';
import {
  createDemoAdapter,
  DEMO_SESSION_KEY,
  type DemoAdapter,
} from './adapters/demo/demo';
import { createSleepClock } from './clock';
import { createSessions, type DetectedSession } from './sessions';

export type DetectionSectionsListener = (
  sections: Partial<StageViewDetectionSections>,
) => void;

export interface DetectionOptions {
  /** main/settings: the timings are its current values. */
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  /** The monotonic clock in ms (default `performance.now`). */
  readonly monotonic?: () => number;
  /** The wall clock in epoch ms (default `Date.now`). */
  readonly wall?: () => number;
  /** Runs `run` once after `delayMs` (default `setTimeout`). */
  readonly setTimer?: (run: () => void, delayMs: number) => unknown;
  /** Cancels a timer setTimer returned (default `clearTimeout`). */
  readonly clearTimer?: (handle: unknown) => void;
  /**
   * The source adapters to run (default none): each starts when detection
   * is created and stops with it.
   */
  readonly adapters?: readonly DetectionAdapter[];
}

export interface Detection {
  /** The current sections. */
  get(): StageViewDetectionSections;
  /** Hears the sections each change changed. Returns an unsubscribe. */
  onChange(listener: DetectionSectionsListener): () => void;
  /**
   * Demo mode: shows `state` on the demo session, turning demo mode on if
   * it is off; null turns it off.
   */
  setDemo(state: StateCode | null): void;
  /** The system is about to sleep. */
  suspend(): void;
  /** The system woke up. */
  resume(): void;
  /**
   * Stops every adapter (closing their watchers) and the sessions' timer,
   * with no further notification (the app is quitting). Afterwards nothing
   * happens.
   */
  stop(): void;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('detection', message, level);
}

/** Same value, as it would be sent over IPC. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A published session as StageView carries it: plain data. */
function toStageSession({
  sessionKey,
  source,
  displayName,
  state,
  confidence,
}: DetectedSession) {
  return { sessionKey, source, displayName, state, confidence };
}

export function createDetection({
  settings,
  monotonic,
  wall = Date.now,
  setTimer = (run, delayMs) => setTimeout(run, delayMs),
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  adapters = [],
}: DetectionOptions): Detection {
  const timings = (): DetectionTimings => settings.get().values;
  const clock = createSleepClock({ monotonic, wall });
  const sessions = createSessions({
    timings,
    now: clock.now,
    wallNow: wall,
    setTimer,
    clearTimer,
  });
  /** Each running adapter's health, in the order they started. */
  const health = new Map<SourceCode, AdapterHealth>();
  let demo: DemoAdapter | undefined;
  const listeners = new Set<DetectionSectionsListener>();
  /** How many batch() calls are under way; changes wait for the last. */
  let batching = 0;
  let stopped = false;

  function current(): StageViewDetectionSections {
    return {
      sessions: sessions.list().map(toStageSession),
      adapters: [...health].map(([source, state]) => ({
        source,
        health: state,
      })),
    };
  }

  let sections = current();

  /** Tells the listeners which sections changed, unless in a batch. */
  function publish(): void {
    if (batching > 0 || stopped) {
      return;
    }
    const next = current();
    const changed: Partial<StageViewDetectionSections> = {};
    if (!same(next.sessions, sections.sessions)) {
      changed.sessions = next.sessions;
    }
    if (!same(next.adapters, sections.adapters)) {
      changed.adapters = next.adapters;
    }
    if (Object.keys(changed).length === 0) {
      return;
    }
    sections = { ...sections, ...changed };
    for (const listener of listeners) {
      try {
        listener(changed);
      } catch (error) {
        log(`a sections listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  /** Runs `run`, then publishes what it changed, once. */
  function batch(run: () => void): void {
    batching += 1;
    try {
      run();
    } finally {
      batching -= 1;
      publish();
    }
  }

  const emit = (output: AdapterOutput): void => {
    sessions.receive(output);
  };

  sessions.onChange(publish);

  /** The source adapters started and not yet stopped. */
  const running = new Set<DetectionAdapter>();

  function startAdapter(adapter: DetectionAdapter): void {
    const context: AdapterContext = {
      emit(outputs, adapterHealth) {
        if (stopped || !running.has(adapter)) {
          return;
        }
        batch(() => {
          if (adapterHealth !== undefined) {
            health.set(adapter.source, adapterHealth);
          }
          for (const output of outputs) {
            sessions.receive(output);
          }
        });
      },
      timings,
      wallNow: wall,
      setTimer,
      clearTimer,
    };
    running.add(adapter);
    try {
      adapter.start(context);
    } catch (error) {
      log(
        `the ${adapter.source} adapter failed to start (${errorCode(error)})`,
        'error',
      );
      // It reads less than it should: nothing, until the app restarts.
      batch(() => {
        health.set(adapter.source, 'degraded');
      });
    }
  }

  function stopAdapter(adapter: DetectionAdapter): void {
    running.delete(adapter);
    try {
      adapter.stop();
    } catch (error) {
      log(
        `the ${adapter.source} adapter failed to stop (${errorCode(error)})`,
        'error',
      );
    }
  }

  settings.onChange(() => {
    if (stopped) {
      return;
    }
    batch(() => {
      demo?.retime();
      sessions.retime();
    });
  });

  for (const adapter of adapters) {
    startAdapter(adapter);
  }

  return {
    get: () => sections,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setDemo(state) {
      if (stopped) {
        return;
      }
      batch(() => {
        if (state === null) {
          demo?.stop();
          demo = undefined;
          health.delete('demo');
          return;
        }
        if (demo === undefined) {
          demo = createDemoAdapter({
            emit,
            timings,
            wallNow: wall,
            setTimer,
            clearTimer,
          });
          health.set('demo', 'ok');
        }
        demo.setState(state);
      });
    },

    suspend() {
      if (!stopped) {
        clock.suspend();
      }
    },

    resume() {
      if (stopped) {
        return;
      }
      const slept = clock.resume();
      log(
        slept === null
          ? 'resumed with no suspend before it; the detection clock is unchanged'
          : `resumed: added ${Math.round(slept)} ms of sleep to the detection clock`,
      );
      batch(() => {
        demo?.refresh();
        sessions.retime();
      });
    },

    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      sessions.stop();
      // stopAdapter removes each from the set; a Set iterates on safely.
      for (const adapter of running) {
        stopAdapter(adapter);
      }
      // Its session.end reaches a stopped sessions: nothing is published.
      demo?.stop();
      demo = undefined;
      health.clear();
    },
  };
}

/**
 * The demo session's state in a `sessions` section; null when it is not
 * there, which means demo mode is off.
 */
export function demoStateOf(
  sessions: StageViewDetectionSections['sessions'],
): StateCode | null {
  return (
    sessions.find((session) => session.sessionKey === DEMO_SESSION_KEY)
      ?.state ?? null
  );
}

/**
 * Calls `listener` with the demo session's state now, then each time it
 * changes, whatever changed it (null: demo mode off). The tray's 示範模式
 * check mark follows it. Returns an unsubscribe.
 */
export function watchDemoState(
  detection: Pick<Detection, 'get' | 'onChange'>,
  listener: (state: StateCode | null) => void,
): () => void {
  let last = demoStateOf(detection.get().sessions);
  listener(last);
  return detection.onChange((sections) => {
    if (sections.sessions === undefined) {
      return;
    }
    const next = demoStateOf(sections.sessions);
    if (next === last) {
      return;
    }
    last = next;
    listener(next);
  });
}

export type SleepEvent = 'suspend' | 'resume';

/** The parts of Electron's `powerMonitor` used here. */
export interface SleepEvents {
  on(event: SleepEvent, listener: () => void): unknown;
}

/**
 * Follows the system's sleep for `detection`'s clock: `suspend` and
 * `resume` go to it. Call once, after `ready`.
 */
export function watchSleep(
  monitor: SleepEvents,
  detection: Pick<Detection, 'suspend' | 'resume'>,
): void {
  monitor.on('suspend', () => {
    detection.suspend();
  });
  monitor.on('resume', () => {
    detection.resume();
  });
}
